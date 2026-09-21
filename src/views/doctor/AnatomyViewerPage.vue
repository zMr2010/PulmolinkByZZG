<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, Eye, EyeOff, Focus, RotateCcw } from 'lucide-vue-next'
import * as THREE from 'three'
import { useRoute, useRouter } from 'vue-router'
import { loadSimulationManifest } from '@/api/simulations'
import { token } from '@/api/client'
import IndependentCtCaseUpload from '@/components/medical/IndependentCtCaseUpload.vue'
import { SceneRuntime } from '@/shared/3d/SceneRuntime'
import { StructureModelManager } from '@/shared/3d/StructureModelManager'
import type { Medical3DManifest } from '@/shared/3d/types'
import { t } from '@/i18n'

const DEMO_MANIFEST = '/simulation/demo/manifest.json'
const CT_MANIFEST = '/simulation/tcga-zf-aa5n/manifest.json'
const route = useRoute()
const router = useRouter()
const host = ref<HTMLDivElement | null>(null)
const manifest = ref<Medical3DManifest | null>(null)
const selectedId = ref<string | null>(null)
const visibility = ref<Record<string, boolean>>({})
const bodyOpacity = ref(0.38)
const loadProgress = ref(0)
const loading = ref(true)
const error = ref('')
const isolated = ref(false)

let runtime: SceneRuntime | undefined
let models: StructureModelManager | undefined
let loadController: AbortController | undefined
let pointerDown: { x: number; y: number } | undefined
let generation = 0

const selectedStructure = computed(() => manifest.value?.structures.find(item => item.id === selectedId.value) || null)
const patientId = computed(() => String(route.params.id || ''))

function cleanupRuntime() {
  generation++
  loadController?.abort()
  const canvas = runtime?.renderer.domElement
  canvas?.removeEventListener('pointerdown', onPointerDown)
  canvas?.removeEventListener('pointerup', onPointerUp)
  models?.dispose()
  runtime?.dispose()
  models = undefined
  runtime = undefined
}

function onPointerDown(event: PointerEvent) {
  pointerDown = { x: event.clientX, y: event.clientY }
}

function onPointerUp(event: PointerEvent) {
  if (!pointerDown || !runtime || !models) return
  const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
  pointerDown = undefined
  if (moved > 5) return
  const rect = runtime.renderer.domElement.getBoundingClientRect()
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), runtime.camera)
  const hit = raycaster.intersectObjects(models.getPickableMeshes(), false)[0]
  selectStructure(hit ? String(hit.object.userData.structureId || '') : null)
}

async function initialize(manifestUrl?: string) {
  cleanupRuntime()
  await nextTick()
  if (!host.value) return
  const currentGeneration = generation
  loading.value = true
  error.value = ''
  loadProgress.value = 0
  selectedId.value = null
  isolated.value = false
  loadController = new AbortController()
  try {
    let loaded: Medical3DManifest
    if (manifestUrl) {
      loaded = await loadSimulationManifest(manifestUrl, loadController.signal)
    } else {
      try {
        loaded = await loadSimulationManifest(CT_MANIFEST, loadController.signal)
      } catch (reason) {
        if (loadController.signal.aborted) throw reason
        loaded = await loadSimulationManifest(DEMO_MANIFEST, loadController.signal)
      }
    }
    if (currentGeneration !== generation || !host.value) return
    manifest.value = loaded
    visibility.value = Object.fromEntries(loaded.structures.map(item => [item.id, item.visible]))
    runtime = new SceneRuntime(host.value)
    const accessToken = manifestUrl?.startsWith('/api/') ? token() : null
    models = new StructureModelManager(
      runtime.scene,
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    )
    const bounds = await models.load(loaded, (completed, total) => {
      loadProgress.value = Math.round(completed / Math.max(total, 1) * 100)
    })
    if (currentGeneration !== generation) return
    models.setBodyOpacity(bodyOpacity.value)
    runtime.fitTo(bounds)
    runtime.renderer.domElement.addEventListener('pointerdown', onPointerDown)
    runtime.renderer.domElement.addEventListener('pointerup', onPointerUp)
    loading.value = false
  } catch (reason) {
    if (loadController?.signal.aborted) return
    console.error('Anatomy viewer initialization failed', reason)
    error.value = t('ui.anatomyViewer.loadFailed')
    loading.value = false
  }
}

function selectStructure(id: string | null) {
  selectedId.value = id || null
  models?.setSelected(selectedId.value)
}

function setVisible(id: string, visible: boolean) {
  visibility.value[id] = visible
  models?.setVisible(id, visible)
  if (!visible && selectedId.value === id) selectStructure(null)
}

function toggleIsolate() {
  isolated.value = !isolated.value
  models?.isolate(isolated.value ? selectedId.value : null)
  if (!isolated.value && manifest.value) {
    for (const structure of manifest.value.structures) models?.setVisible(structure.id, visibility.value[structure.id] ?? structure.visible)
  }
}

function exitViewer() {
  void router.push({ name: 'doctor-patient-3d', params: { id: patientId.value } })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') exitViewer()
}

watch(bodyOpacity, value => models?.setBodyOpacity(value))
watch(patientId, () => { void initialize() })
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void initialize()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  cleanupRuntime()
})
</script>

<template>
  <section class="anatomy-viewer-page" data-testid="anatomy-viewer">
    <header class="viewer-header">
      <div>
        <span class="eyebrow">{{ $t('ui.anatomyViewer.mode') }}</span>
        <h2>{{ $t('ui.anatomyViewer.title') }}</h2>
        <p>{{ $t('ui.anatomyViewer.description') }}</p>
      </div>
      <div class="header-actions">
        <button type="button" class="viewer-button" @click="runtime?.resetCamera()"><RotateCcw :size="16" />{{ $t('ui.anatomyViewer.resetCamera') }}</button>
        <button type="button" class="viewer-button primary" @click="exitViewer"><ArrowLeft :size="16" />{{ $t('ui.anatomyViewer.exit') }}</button>
      </div>
    </header>

    <IndependentCtCaseUpload purpose="anatomy" @ready="initialize" />

    <div class="viewer-layout">
      <div class="viewport-card">
        <div class="viewer-toolbar">
          <span>{{ $t('ui.anatomyViewer.patient', { id: patientId }) }}</span>
          <label>{{ $t('ui.anatomyViewer.skinOpacity') }} <input v-model.number="bodyOpacity" type="range" min="0.08" max="1" step="0.02"></label>
        </div>
        <div ref="host" class="viewer-canvas" data-testid="anatomy-canvas" />
        <div v-if="loading" class="viewport-state">{{ $t('ui.anatomyViewer.loading', { progress: loadProgress }) }}</div>
        <div v-else-if="error" class="viewport-state error" role="alert">{{ error }}</div>
        <div class="navigation-help">{{ $t('ui.anatomyViewer.navigationHelp') }}</div>
      </div>

      <aside class="organ-panel" data-testid="organ-visibility-panel">
        <div class="panel-heading">
          <div><h3>{{ $t('ui.anatomyViewer.structures') }}</h3><p>{{ $t('ui.anatomyViewer.selectHelp') }}</p></div>
          <span>{{ manifest?.structures.length || 0 }}</span>
        </div>
        <button
          v-for="structure in manifest?.structures || []"
          :key="structure.id"
          type="button"
          class="structure-row"
          :class="{ selected: selectedId === structure.id }"
          @click="selectStructure(structure.id)"
        >
          <span class="color-dot" :style="{ background: structure.material.color }" />
          <span><strong>{{ structure.name }}</strong><small>{{ structure.type }}</small></span>
          <span class="visibility" @click.stop="setVisible(structure.id, !visibility[structure.id])">
            <Eye v-if="visibility[structure.id]" :size="16" /><EyeOff v-else :size="16" />
          </span>
        </button>
        <button type="button" class="isolate-button" :disabled="!selectedId" @click="toggleIsolate"><Focus :size="15" />{{ isolated ? $t('ui.anatomyViewer.showAll') : $t('ui.anatomyViewer.isolate') }}</button>
        <dl v-if="selectedStructure" class="model-info">
          <div><dt>{{ $t('ui.anatomyViewer.selected') }}</dt><dd>{{ selectedStructure.name }}</dd></div>
          <div><dt>{{ $t('ui.anatomyViewer.structureType') }}</dt><dd>{{ selectedStructure.type }}</dd></div>
          <div v-if="selectedStructure.metadata.volumeCm3"><dt>{{ $t('ui.anatomyViewer.volume') }}</dt><dd>{{ Number(selectedStructure.metadata.volumeCm3).toFixed(1) }} cm³</dd></div>
        </dl>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.anatomy-viewer-page{display:grid;gap:14px}.viewer-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px 20px;border:1px solid #1d353c;border-radius:14px;background:linear-gradient(120deg,#0b2026,#102d34);color:#f4fbfc}.eyebrow{color:#68d7e5;font-size:9px;font-weight:800;letter-spacing:.16em}.viewer-header h2{margin:5px 0 4px;font-size:21px}.viewer-header p{max-width:720px;margin:0;color:#a9c0c6;font-size:11px}.header-actions{display:flex;flex-wrap:wrap;gap:8px}.viewer-button,.isolate-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:8px 12px;border:1px solid #31505a;border-radius:8px;background:#16343c;color:#dbecef;font-size:12px}.viewer-button.primary{border-color:#5fc5cf;background:#267c82}.viewer-layout{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:14px;min-height:680px}.viewport-card{position:relative;overflow:hidden;border:1px solid #1d353c;border-radius:14px;background:#071418}.viewer-toolbar{display:flex;min-height:44px;align-items:center;justify-content:space-between;gap:12px;padding:7px 12px;border-bottom:1px solid #1d353c;background:#0d2329;color:#bad0d5;font-size:11px}.viewer-toolbar label{display:flex;align-items:center;gap:8px}.viewer-toolbar input{width:120px;accent-color:#5fd2df}.viewer-canvas{height:624px;touch-action:none}.viewport-state{position:absolute;inset:44px 0 39px;display:grid;place-items:center;background:#071418e8;color:#c6dce1}.viewport-state.error{color:#ff9ca5}.navigation-help{position:absolute;right:12px;bottom:11px;left:12px;padding:8px 11px;border:1px solid #2c4c55;border-radius:8px;background:#08191fe8;color:#b9d2d7;font-size:11px;pointer-events:none}.organ-panel{padding:13px;border:1px solid #d7e4e5;border-radius:12px;background:#fff}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:9px}.panel-heading h3{margin:0;font-size:13px}.panel-heading p{margin:4px 0 0;color:#71878c;font-size:9px}.panel-heading>span{color:#6e8a91;font-size:10px}.structure-row{display:grid;width:100%;grid-template-columns:10px 1fr 24px;align-items:center;gap:9px;padding:8px 6px;border:0;border-bottom:1px solid #edf2f2;background:transparent;color:#294248;text-align:left}.structure-row.selected{border-radius:7px;background:#e7f6f7}.color-dot{width:8px;height:8px;border-radius:50%}.structure-row strong,.structure-row small{display:block}.structure-row strong{font-size:11px}.structure-row small{margin-top:2px;color:#84999e;font-size:8px}.visibility{display:grid;place-items:center;color:#617e84}.isolate-button{width:100%;margin-top:10px;border-color:#bdd9dc;background:#eff8f8;color:#236f78}.isolate-button:disabled{opacity:.45}.model-info{display:grid;gap:7px;margin:14px 0 0;padding-top:12px;border-top:1px solid #edf2f2}.model-info div{display:flex;justify-content:space-between;gap:10px}.model-info dt,.model-info dd{margin:0;font-size:9px}.model-info dt{color:#71878c}.model-info dd{text-align:right;color:#294248}@media(max-width:1000px){.viewer-header{align-items:flex-start;flex-direction:column}.viewer-layout{grid-template-columns:1fr}.viewer-canvas{height:520px}}@media(max-width:650px){.viewer-canvas{height:430px}.viewer-toolbar{align-items:flex-start;flex-direction:column}}
</style>
