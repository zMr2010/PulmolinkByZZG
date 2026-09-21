<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Upload } from 'lucide-vue-next'
import { getSimulationCase, uploadSimulationCase, type SimulationJob } from '@/api/simulations'
import { t } from '@/i18n'
import { isNiftiFileName, NIFTI_FILE_ACCEPT } from '@/utils/nifti'
import { localPreview } from '@/utils/runtime'

const props = defineProps<{
  purpose: 'anatomy' | 'simulation'
}>()

const emit = defineEmits<{
  ready: [manifestUrl: string]
}>()

const file = ref<File | null>(null)
const job = ref<SimulationJob | null>(null)
const error = ref('')
const busy = ref(false)
const uploadProgress = ref(0)
const input = ref<HTMLInputElement | null>(null)
const controller = new AbortController()
let pollTimer: number | undefined

const canUpload = computed(() => !!file.value && !busy.value && !localPreview)
const titleKey = computed(() => props.purpose === 'anatomy'
  ? 'ui.anatomyViewer.uploadCtTitle'
  : 'ui.simulation.uploadCtTitle')
const helpKey = computed(() => props.purpose === 'anatomy'
  ? 'ui.anatomyViewer.uploadCtHelp'
  : 'ui.simulation.uploadCtHelp')

function selectFile(event: Event) {
  const element = event.target as HTMLInputElement
  const selected = element.files?.[0] || null
  element.value = ''
  error.value = ''
  job.value = null
  if (selected && !isNiftiFileName(selected.name)) {
    file.value = null
    error.value = t('ui.simulation.invalidCt')
    return
  }
  file.value = selected
}

function schedulePoll(caseId: string) {
  window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(() => { void poll(caseId) }, 1200)
}

async function poll(caseId: string) {
  if (controller.signal.aborted) return
  try {
    const next = await getSimulationCase(caseId)
    job.value = next
    if (next.status === 'READY' && next.manifestUrl) {
      busy.value = false
      emit('ready', next.manifestUrl)
      return
    }
    if (next.status === 'FAILED') {
      busy.value = false
      error.value = next.errorCode === 'MODEL_UNAVAILABLE'
        ? t('ui.simulation.modelUnavailable')
        : next.errorMessage || t('ui.simulation.buildFailed')
      return
    }
    schedulePoll(caseId)
  } catch (reason) {
    busy.value = false
    error.value = reason instanceof Error ? reason.message : t('ui.simulation.buildFailed')
  }
}

async function submit() {
  if (!file.value || !canUpload.value) return
  busy.value = true
  error.value = ''
  uploadProgress.value = 0
  try {
    const created = await uploadSimulationCase(file.value, {
      signal: controller.signal,
      onProgress: progress => { uploadProgress.value = progress.percent },
    })
    job.value = created
    schedulePoll(created.caseId)
  } catch (reason) {
    busy.value = false
    if (reason instanceof DOMException && reason.name === 'AbortError') return
    error.value = reason instanceof Error ? reason.message : t('ui.simulation.uploadFailed')
  }
}

onBeforeUnmount(() => {
  window.clearTimeout(pollTimer)
  controller.abort()
})
</script>

<template>
  <section class="ct-case-source" :aria-label="$t('ui.simulation.independentInput')">
    <div>
      <span class="source-kicker">{{ $t('ui.simulation.independentInput') }}</span>
      <h3>{{ $t(titleKey) }}</h3>
      <p>{{ $t(helpKey) }}</p>
      <p v-if="localPreview" class="source-warning">{{ $t('ui.simulation.fullStackRequired') }}</p>
      <p v-if="error" class="source-error" role="alert">{{ error }}</p>
      <p v-if="job && !error" class="source-status" role="status">
        {{ $t('ui.simulation.jobStatus', { status: job.status, progress: job.progress }) }}
      </p>
    </div>
    <div class="source-actions">
      <button type="button" class="source-button source-picker" :disabled="busy" @click="input?.click()">
        <Upload :size="16" />{{ file?.name || $t('ui.simulation.chooseCt') }}
      </button>
      <input ref="input" class="source-input" type="file" :accept="NIFTI_FILE_ACCEPT" @change="selectFile" />
      <button type="button" class="source-button primary" :disabled="!canUpload" @click="submit">
        {{ busy ? $t('ui.simulation.uploadingCt', { progress: uploadProgress }) : $t('ui.simulation.buildFromCt') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ct-case-source{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 16px;border:1px solid #c8dddf;border-radius:12px;background:#f7fbfb}.ct-case-source h3{margin:3px 0 4px;font-size:14px}.ct-case-source p{max-width:760px;margin:0;color:#617a80;font-size:10px;line-height:1.5}.source-kicker{color:#23808b;font-size:8px;font-weight:800;letter-spacing:.13em}.source-actions{display:flex;align-items:center;gap:8px;min-width:300px}.source-button{display:inline-flex;min-height:36px;align-items:center;justify-content:center;gap:7px;padding:8px 12px;border:1px solid #a9ced2;border-radius:8px;background:#fff;color:#286b73;font-size:12px}.source-button.primary{border-color:#267c82;background:#267c82;color:#fff}.source-button:disabled{cursor:not-allowed;opacity:.45}.source-picker{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-input{display:none}.source-warning,.source-error{margin-top:5px!important;color:#a55c22!important}.source-error{color:#b53d49!important}.source-status{margin-top:5px!important;color:#23727b!important;font-weight:650}@media(max-width:1000px){.ct-case-source{align-items:flex-start;flex-direction:column}.source-actions{width:100%;min-width:0}}@media(max-width:650px){.source-actions{align-items:stretch;flex-direction:column}.source-picker{max-width:none}}
</style>
