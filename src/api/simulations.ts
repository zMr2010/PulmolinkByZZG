import { ApiError, api, request, token } from './client'
import { parseSimulationManifest } from '@/simulation/manifest'
import type { SimulationManifest } from '@/simulation/types'
import type { UploadProgress } from './examinations'

export type SimulationJobStatus = 'PENDING' | 'SEGMENTING' | 'MESH_PROCESSING' | 'READY' | 'FAILED'

export interface SimulationJob {
  caseId: string
  sourceFilename: string
  status: SimulationJobStatus
  progress: number
  manifestUrl?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

interface SimulationJobDTO {
  case_id: string
  source_filename: string
  status: SimulationJobStatus
  progress: number
  manifest_url?: string | null
  error_code?: string | null
  error_message?: string | null
}

function mapJob(value: SimulationJobDTO): SimulationJob {
  return {
    caseId: value.case_id,
    sourceFilename: value.source_filename,
    status: value.status,
    progress: value.progress,
    manifestUrl: value.manifest_url,
    errorCode: value.error_code,
    errorMessage: value.error_message,
  }
}

export function uploadSimulationCase(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void } = {},
): Promise<SimulationJob> {
  const form = new FormData()
  form.append('file', file)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    xhr.open('POST', '/api/v1/simulation-cases')
    xhr.timeout = 30 * 60_000
    const accessToken = token()
    if (accessToken) xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken)
    xhr.upload.onprogress = event => {
      const total = event.lengthComputable ? event.total : file.size
      const percent = total > 0 ? Math.min(100, Math.round(event.loaded / total * 100)) : 0
      options.onProgress?.({ phase: 'uploading', loaded: event.loaded, total, percent })
    }
    xhr.upload.onload = () => options.onProgress?.({ phase: 'processing', loaded: file.size, total: file.size, percent: 100 })
    xhr.onload = () => {
      cleanup()
      let payload: { data?: SimulationJobDTO; code?: number; message?: string } = {}
      try { payload = JSON.parse(xhr.responseText || '{}') }
      catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.data) {
        resolve(mapJob(payload.data))
        return
      }
      reject(new ApiError(xhr.status, payload.code || 0, payload.message || 'Simulation CT upload failed', {
        retryable: xhr.status === 0 || xhr.status >= 500,
      }))
    }
    xhr.onerror = () => { cleanup(); reject(new ApiError(0, 0, 'Simulation CT upload connection was interrupted', { retryable: true })) }
    xhr.ontimeout = () => { cleanup(); reject(new ApiError(0, 40800, 'Simulation CT upload timed out', { retryable: true })) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')) }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    else xhr.send(form)
  })
}

export async function getSimulationCase(caseId: string): Promise<SimulationJob> {
  return mapJob(await api<SimulationJobDTO>(`/simulation-cases/${caseId}`))
}

export async function loadSimulationManifest(url: string, signal?: AbortSignal): Promise<SimulationManifest> {
  const response = url.startsWith('/api/')
    ? await request(url, { signal })
    : await fetch(url, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Simulation manifest failed to load (${response.status})`)
  const payload = await response.json()
  return parseSimulationManifest(url.startsWith('/api/') ? payload.data : payload)
}
