import { ApiError, api, collection, token } from './client'
import { mapImage, type ImageDTO } from './mappers'
import { t } from '@/i18n'

export interface UploadProgress {
  phase: 'uploading' | 'processing'
  loaded: number
  total: number
  percent: number
}

export const examinationApi = {
  async getExaminationsByPatient(id: string) { return (await collection<ImageDTO>('/patients/' + id + '/medical-images')).map(mapImage) },
  async getExaminationById(id: string) { return mapImage(await api<ImageDTO>('/medical-images/' + id)) },
  async uploadStudy(
    patientId: string,
    file: File,
    organId: string,
    imageType: 'CT' | 'MRI',
    studyDate: string,
    options: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void } = {},
  ) {
    const form = new FormData()
    form.append('file', file)
    form.append('organ_id', organId)
    form.append('image_type', imageType)
    if (studyDate) form.append('study_date', studyDate)
    if (!options.signal && !options.onProgress) {
      return mapImage(await api<ImageDTO>('/patients/' + patientId + '/medical-images', {
        method: 'POST',
        body: form,
      }))
    }

    return new Promise<ReturnType<typeof mapImage>>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      xhr.open('POST', '/api/v1/patients/' + patientId + '/medical-images')
      // Upload progress may finish long before the server has canonicalized and
      // cached every CT slice. Allow large clinical volumes to finish processing.
      xhr.timeout = 30 * 60_000
      const accessToken = token()
      if (accessToken) xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken)
      xhr.upload.onprogress = event => {
        const total = event.lengthComputable ? event.total : file.size
        const percent = total > 0 ? Math.min(100, Math.round(event.loaded / total * 100)) : 0
        options.onProgress?.({ phase: 'uploading', loaded: event.loaded, total, percent })
      }
      xhr.upload.onload = () => options.onProgress?.({ phase: 'processing', loaded: file.size, total: file.size, percent: 100 })
      const cleanup = () => options.signal?.removeEventListener('abort', abort)
      xhr.onload = () => {
        cleanup()
        let payload: { data?: ImageDTO; code?: number; message?: string } = {}
        try { payload = JSON.parse(xhr.responseText || '{}') }
        catch { /* handled by status below */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.data) {
        resolve(mapImage(payload.data))
        return
      }
      const messageKey: Record<number, string> = {
        40002: 'errors.40002',
        40004: 'errors.40004',
        41301: 'errors.41301',
        41302: 'errors.41302',
        41303: 'errors.41303',
      }
      const message = payload.code && messageKey[payload.code]
        ? t(messageKey[payload.code])
        : payload.message || t('ui.upload.failed')
      reject(new ApiError(xhr.status, payload.code || 0, message, { retryable: xhr.status === 0 || xhr.status >= 500 }))
      }
      xhr.onerror = () => { cleanup(); reject(new ApiError(0, 0, '上传连接中断，请重试。', { retryable: true })) }
      xhr.ontimeout = () => { cleanup(); reject(new ApiError(0, 40800, '影像处理超时，请重试或检查体积限制。', { retryable: true })) }
      xhr.onabort = () => { cleanup(); reject(new DOMException('上传已取消', 'AbortError')) }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      else xhr.send(form)
    })
  },
}
