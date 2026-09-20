import * as THREE from 'three'
import type { CutResult } from '../types'
import { rebuildBoundsTree, refitBoundsTree } from '../core/bvh'
import { ObjectSimulationState } from '../physics/SimulationState'
import {
  nearestBoundaryVertexAtFraction,
  nearestMergeBoundaryVertex,
  regularOpeningPositions,
  woundBoundaryGeometry,
  woundControlPolygonGeometry,
  woundInteriorGeometry,
  woundSidewallGeometry,
} from './woundGeometry'

interface PredictedOpening extends CutResult {
  positions: Float32Array
  closedPositions: Float32Array
  indices: Uint32Array
}

export interface AppliedCut {
  mesh: THREE.Mesh
  result: CutResult
  path: Uint32Array
  predictionOnly: true
  basedOnTopologyVersion: number
  depthPercent: number
  depthMeters: number
}

interface PredictedWound {
  id: number
  mesh: THREE.Mesh
  leftBoundary: Uint32Array
  rightBoundary: Uint32Array
  boundaryOverlay: THREE.Mesh
  sidewallOverlay: THREE.Mesh
  interiorOverlay: THREE.Mesh
  depthPercent: number
  depthMeters: number
  tubeRadius: number
  regularBasePositions: Float32Array
  regularDisplacement: Float32Array
  openingPercent: number
  polygonVertexIds: Uint32Array
}

function packedGeometry(mesh: THREE.Mesh) {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  if (!(position instanceof THREE.BufferAttribute) || position.itemSize !== 3) {
    throw new Error('Incision requires a packed xyz position attribute')
  }
  if (!geometry.index) throw new Error('Incision requires indexed triangle geometry')
  return {
    positions: new Float32Array(position.array),
    indices: new Uint32Array(geometry.index.array),
  }
}

export class CutManager {
  private states = new WeakMap<THREE.Mesh, ObjectSimulationState>()
  private readonly wounds: PredictedWound[] = []
  private nextWoundId = 1
  private activeWoundId: number | null = null
  private readonly overlays = new Set<THREE.Object3D>()
  private readonly controls: THREE.Mesh[] = []
  private previewLine?: THREE.Line
  private previewMesh?: THREE.Mesh
  private previewPath?: Uint32Array
  private pathWorker?: Worker
  private pathRequestId = 0
  private rejectPath?: (reason: Error) => void
  private cutWorker?: Worker
  private cutRequestId = 0
  private rejectCut?: (reason: Error) => void
  private showPath = true
  private showBoundary = true
  private showControls = true

  setDebugVisibility(options: { path: boolean; boundary: boolean; controls: boolean }) {
    this.showPath = options.path
    this.showBoundary = options.boundary
    this.showControls = options.controls
    if (this.previewLine) this.previewLine.visible = options.path
    for (const overlay of this.overlays) {
      if (overlay.userData.kind === 'boundary') overlay.visible = options.boundary
      if (overlay.userData.kind === 'control') overlay.visible = options.controls
    }
  }

  markPoint(mesh: THREE.Mesh, localPosition: THREE.Vector3, label: 'A' | 'B') {
    mesh.geometry.computeBoundingSphere()
    const markerRadius = Math.min(0.01, Math.max(0.004, (mesh.geometry.boundingSphere?.radius ?? 0.25) * 0.016))
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius, 16, 12),
      new THREE.MeshBasicMaterial({ color: label === 'A' ? 0x4dd8ff : 0xffd166, depthTest: false }),
    )
    marker.position.copy(localPosition)
    marker.renderOrder = 20
    marker.userData.kind = 'point'
    mesh.add(marker)
    this.overlays.add(marker)
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = label === 'A' ? '#4dd8ff' : '#ffd166'
      context.font = '700 42px sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, 32, 32)
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }))
      sprite.position.copy(localPosition).add(new THREE.Vector3(0, 0.035, 0))
      sprite.scale.setScalar(0.045)
      sprite.renderOrder = 22
      sprite.userData.kind = 'point'
      mesh.add(sprite)
      this.overlays.add(sprite)
    }
  }

  async preview(mesh: THREE.Mesh, start: number, end: number) {
    this.cancelPathCalculation()
    this.removePreview()
    const { positions, indices } = packedGeometry(mesh)
    this.ensureState(mesh, positions, indices)
    mesh.geometry.computeBoundingSphere()
    const mergeDistance = Math.max(0.004, (mesh.geometry.boundingSphere?.radius ?? 1) * 0.018)
    const existingBoundaries = this.wounds
      .filter(wound => wound.mesh === mesh)
      .flatMap(wound => [wound.leftBoundary, wound.rightBoundary])
    const snappedStart = nearestMergeBoundaryVertex(positions, existingBoundaries, start, mergeDistance)
    const snappedEnd = nearestMergeBoundaryVertex(positions, existingBoundaries, end, mergeDistance)
    if (snappedStart === snappedEnd) throw new Error('Choose two distinct wound or surface points')
    const path = await this.calculatePath(positions, indices, snappedStart, snappedEnd)
    if (path.length < 4) throw new Error('Choose surface points farther apart to create a stable opening')
    const currentPositions = packedGeometry(mesh).positions
    const pathPositions = new Float32Array(path.length * 3)
    path.forEach((vertexId, index) => {
      pathPositions.set(currentPositions.subarray(vertexId * 3, vertexId * 3 + 3), index * 3)
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3))
    const material = new THREE.LineBasicMaterial({ color: 0xff6b7a, depthTest: false, transparent: true, opacity: 0.95 })
    this.previewLine = new THREE.Line(geometry, material)
    this.previewLine.renderOrder = 19
    this.previewLine.visible = this.showPath
    this.previewLine.userData.kind = 'preview'
    mesh.add(this.previewLine)
    this.previewMesh = mesh
    this.previewPath = path
    return path
  }

  async commitPrediction(depthPercent: number, openingPercent = 45): Promise<AppliedCut> {
    if (!this.previewMesh || !this.previewPath) throw new Error('No incision preview is ready')
    const mesh = this.previewMesh
    const path = this.previewPath
    const { positions, indices } = packedGeometry(mesh)
    const state = this.ensureState(mesh, positions, indices)
    mesh.geometry.computeBoundingSphere()
    const radius = mesh.geometry.boundingSphere?.radius ?? 1
    const normalizedDepth = THREE.MathUtils.clamp(depthPercent, 5, 100)
    const configuredThickness = Number(mesh.userData.cuttableThicknessMeters)
    const cuttableThickness = Number.isFinite(configuredThickness) && configuredThickness > 0
      ? configuredThickness
      : Math.min(0.05, Math.max(0.008, radius * 0.08))
    const depthMeters = cuttableThickness * normalizedDepth / 100
    const split = await this.calculateOpening(
      positions,
      indices,
      path,
      Math.min(0.075, Math.max(0.008, radius * 0.2)),
    )
    const regular = regularOpeningPositions(split.closedPositions, split.positions, openingPercent)
    state.setPredictedTopologyHint(regular.positions, split.indices)
    this.removePreview()

    const geometry = mesh.geometry
    for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name)
    geometry.setAttribute('position', new THREE.BufferAttribute(state.visualPositions, 3))
    geometry.setIndex(new THREE.BufferAttribute(split.indices, 1))
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    rebuildBoundsTree(geometry)

    this.removeSelectionPoints(mesh)
    const wound = this.addWound(
      mesh,
      split.leftBoundary,
      split.rightBoundary,
      normalizedDepth,
      depthMeters,
      split.closedPositions,
      regular.displacement,
      THREE.MathUtils.clamp(openingPercent, 0, 100),
    )
    this.addWoundControls(wound, state.visualPositions)

    return {
      mesh,
      path,
      predictionOnly: true,
      basedOnTopologyVersion: state.topologyVersion,
      depthPercent: normalizedDepth,
      depthMeters,
      result: {
        leftBoundary: split.leftBoundary,
        rightBoundary: split.rightBoundary,
        affectedTriangles: split.affectedTriangles,
        newVertices: split.newVertices,
        removedConstraints: split.removedConstraints,
      },
    }
  }

  acceptPredictedGeometry(mesh: THREE.Mesh) {
    const state = this.states.get(mesh)
    if (!state?.predictedTopologyHint) return
    const position = mesh.geometry.getAttribute('position')
    state.updatePredictedTopologyPositions(new Float32Array(position.array))
  }

  getState(mesh: THREE.Mesh) {
    return this.states.get(mesh)
  }

  isPredictedCut(mesh: THREE.Mesh) {
    return this.wounds.some(wound => wound.mesh === mesh)
  }

  hasPredictedCuts() {
    return this.wounds.length > 0
  }

  getControlMeshes() {
    return this.controls
  }

  selectWound(woundId: number) {
    if (this.wounds.some(wound => wound.id === woundId)) this.activeWoundId = woundId
  }

  setActiveWoundOpening(openingPercent: number) {
    const wound = this.wounds.find(item => item.id === this.activeWoundId) ?? this.wounds.at(-1)
    if (!wound) return false
    const nextPercent = THREE.MathUtils.clamp(openingPercent, 0, 100)
    const position = wound.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const limit = Math.min(position.array.length, wound.regularBasePositions.length)
    const scale = nextPercent / 100
    for (let index = 0; index < limit; index += 3) {
      const dx = wound.regularDisplacement[index]
      const dy = wound.regularDisplacement[index + 1]
      const dz = wound.regularDisplacement[index + 2]
      if (dx * dx + dy * dy + dz * dz < 1e-16) continue
      position.setXYZ(
        index / 3,
        wound.regularBasePositions[index] + dx * scale,
        wound.regularBasePositions[index + 1] + dy * scale,
        wound.regularBasePositions[index + 2] + dz * scale,
      )
    }
    position.needsUpdate = true
    wound.openingPercent = nextPercent
    wound.mesh.geometry.computeVertexNormals()
    wound.mesh.geometry.computeBoundingBox()
    wound.mesh.geometry.computeBoundingSphere()
    refitBoundsTree(wound.mesh.geometry)
    this.acceptPredictedGeometry(wound.mesh)
    this.updateControlPositions(wound.mesh)
    return true
  }

  updateControlPositions(mesh: THREE.Mesh) {
    const position = mesh.geometry.getAttribute('position')
    for (const control of this.controls) {
      if (control.userData.targetMesh !== mesh) continue
      const vertexId = Number(control.userData.vertexId)
      if (!Number.isInteger(vertexId) || vertexId < 0 || vertexId >= position.count) continue
      control.position.fromBufferAttribute(position, vertexId)
    }
    const normal = mesh.geometry.getAttribute('normal')
    for (const wound of this.wounds) {
      if (wound.mesh !== mesh) continue
      wound.boundaryOverlay.geometry.dispose()
      wound.boundaryOverlay.geometry = wound.polygonVertexIds.length >= 3
        ? woundControlPolygonGeometry(position, wound.polygonVertexIds, wound.tubeRadius)
        : woundBoundaryGeometry(position, wound.leftBoundary, wound.rightBoundary, wound.tubeRadius)
      wound.sidewallOverlay.geometry.dispose()
      wound.sidewallOverlay.geometry = woundSidewallGeometry(
        position,
        normal,
        wound.leftBoundary,
        wound.rightBoundary,
        wound.depthMeters,
      )
      wound.interiorOverlay.geometry.dispose()
      wound.interiorOverlay.geometry = woundInteriorGeometry(
        position,
        normal,
        wound.leftBoundary,
        wound.rightBoundary,
        wound.depthMeters,
      )
    }
  }

  clear() {
    this.cancelPathCalculation()
    this.cancelCutCalculation()
    this.removePreview()
    for (const overlay of this.overlays) {
      overlay.removeFromParent()
      if (overlay instanceof THREE.Mesh || overlay instanceof THREE.Line) {
        overlay.geometry.dispose()
        const materials = Array.isArray(overlay.material) ? overlay.material : [overlay.material]
        materials.forEach(material => material.dispose())
      } else if (overlay instanceof THREE.Sprite) {
        overlay.material.map?.dispose()
        overlay.material.dispose()
      }
    }
    this.overlays.clear()
    this.controls.length = 0
    this.states = new WeakMap<THREE.Mesh, ObjectSimulationState>()
    this.wounds.length = 0
    this.nextWoundId = 1
    this.activeWoundId = null
  }

  private addWound(
    mesh: THREE.Mesh,
    left: Uint32Array,
    right: Uint32Array,
    depthPercent: number,
    depthMeters: number,
    regularBasePositions: Float32Array,
    regularDisplacement: Float32Array,
    openingPercent: number,
  ) {
    const position = mesh.geometry.getAttribute('position')
    const normal = mesh.geometry.getAttribute('normal')
    mesh.geometry.computeBoundingSphere()
    const tubeRadius = Math.min(0.003, Math.max(0.0012, (mesh.geometry.boundingSphere?.radius ?? 0.25) * 0.005))
    const boundaryMesh = new THREE.Mesh(
      woundBoundaryGeometry(position, left, right, tubeRadius),
      new THREE.MeshBasicMaterial({ color: 0x661b26, depthTest: true, depthWrite: false }),
    )
    boundaryMesh.renderOrder = 18
    boundaryMesh.visible = this.showBoundary
    boundaryMesh.userData.kind = 'boundary'
    boundaryMesh.userData.targetMesh = mesh
    boundaryMesh.userData.leftBoundary = left
    boundaryMesh.userData.rightBoundary = right
    mesh.add(boundaryMesh)
    this.overlays.add(boundaryMesh)
    const sidewall = new THREE.Mesh(
      woundSidewallGeometry(position, normal, left, right, depthMeters),
      new THREE.MeshPhysicalMaterial({
        color: 0x9b3f48,
        roughness: 0.72,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    )
    sidewall.renderOrder = 17
    sidewall.userData.kind = 'sidewall'
    sidewall.userData.targetMesh = mesh
    mesh.add(sidewall)
    this.overlays.add(sidewall)
    const sourceMaterial = mesh.material as THREE.MeshPhysicalMaterial
    const interiorColor = sourceMaterial.color.clone().lerp(new THREE.Color(0x7e2635), mesh.userData.structureType === 'body' ? 0.68 : 0.4)
    const isBodyEnvelope = mesh.userData.structureType === 'body'
    const interiorOpacity = depthPercent >= 95 ? 0.1 : isBodyEnvelope ? 0.38 : 0.94
    const interior = new THREE.Mesh(
      woundInteriorGeometry(position, normal, left, right, depthMeters),
      new THREE.MeshPhysicalMaterial({
        color: interiorColor,
        roughness: 0.82,
        side: THREE.DoubleSide,
        transparent: interiorOpacity < 1,
        opacity: interiorOpacity,
        depthWrite: interiorOpacity >= 0.9,
      }),
    )
    interior.renderOrder = 16
    interior.userData.kind = 'interior'
    interior.userData.targetMesh = mesh
    mesh.add(interior)
    this.overlays.add(interior)
    const wound: PredictedWound = {
      id: this.nextWoundId++, mesh, leftBoundary: left, rightBoundary: right,
      boundaryOverlay: boundaryMesh, sidewallOverlay: sidewall, interiorOverlay: interior,
      depthPercent, depthMeters, tubeRadius,
      regularBasePositions: new Float32Array(regularBasePositions),
      regularDisplacement: new Float32Array(regularDisplacement),
      openingPercent,
      polygonVertexIds: new Uint32Array(),
    }
    this.wounds.push(wound)
    this.activeWoundId = wound.id
    return wound
  }

  private addWoundControls(wound: PredictedWound, positions: Float32Array) {
    const { mesh, leftBoundary, rightBoundary, id: woundId } = wound
    this.addControl(
      mesh,
      positions,
      leftBoundary[0],
      [leftBoundary[0], rightBoundary[0]],
      0x263b43,
      'endpoint-a',
      woundId,
      0,
    )
    const last = leftBoundary.length - 1
    this.addControl(
      mesh,
      positions,
      leftBoundary[last],
      [leftBoundary[last], rightBoundary[last]],
      0x263b43,
      'endpoint-b',
      woundId,
      1,
    )
    const leftControls = this.addSideControls(mesh, positions, leftBoundary, 0x4dd8ff, 'left', woundId)
    const rightControls = this.addSideControls(mesh, positions, rightBoundary, 0xffd166, 'right', woundId)
    wound.polygonVertexIds = Uint32Array.from([
      leftBoundary[0],
      ...leftControls,
      leftBoundary[last],
      ...rightControls.reverse(),
    ])
    wound.boundaryOverlay.geometry.dispose()
    wound.boundaryOverlay.geometry = woundControlPolygonGeometry(
      mesh.geometry.getAttribute('position'),
      wound.polygonVertexIds,
      wound.tubeRadius,
    )
  }

  private addSideControls(
    mesh: THREE.Mesh,
    positions: Float32Array,
    boundary: Uint32Array,
    color: number,
    side: string,
    woundId: number,
  ) {
    const mapped = new Set<number>()
    for (const fraction of [0.25, 0.5, 0.75]) {
      const vertexId = nearestBoundaryVertexAtFraction(positions, boundary, fraction)
      if (mapped.has(vertexId) || vertexId === boundary[0] || vertexId === boundary[boundary.length - 1]) continue
      mapped.add(vertexId)
      this.addControl(
        mesh,
        positions,
        vertexId,
        this.boundaryAnchorPatch(boundary, vertexId),
        color,
        side,
        woundId,
        fraction,
      )
    }
    return [...mapped]
  }

  private boundaryAnchorPatch(boundary: Uint32Array, centerVertexId: number) {
    const center = boundary.indexOf(centerVertexId)
    if (center < 0) return [centerVertexId]
    const halfSpan = Math.max(1, Math.min(3, Math.floor(boundary.length * 0.04)))
    const anchors: number[] = []
    for (let offset = -halfSpan; offset <= halfSpan; offset++) {
      const index = center + offset
      if (index <= 0 || index >= boundary.length - 1) continue
      anchors.push(boundary[index])
    }
    return anchors.length ? anchors : [centerVertexId]
  }

  private addControl(
    mesh: THREE.Mesh,
    positions: Float32Array,
    displayVertexId: number,
    vertexIds: number[],
    color: number,
    side: string,
    woundId: number,
    arcFraction: number,
  ) {
    mesh.geometry.computeBoundingSphere()
    const controlRadius = Math.min(0.01, Math.max(0.004, (mesh.geometry.boundingSphere?.radius ?? 0.25) * 0.016))
    const control = new THREE.Mesh(
      new THREE.SphereGeometry(controlRadius, 14, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: false }),
    )
    control.position.fromArray(positions, displayVertexId * 3)
    control.renderOrder = 21
    control.visible = this.showControls
    control.userData.kind = 'control'
    control.userData.side = side
    control.userData.woundId = woundId
    control.userData.arcFraction = arcFraction
    control.userData.vertexId = displayVertexId
    control.userData.vertexIds = [...vertexIds]
    control.userData.targetMesh = mesh
    mesh.add(control)
    this.controls.push(control)
    this.overlays.add(control)
  }

  private removeSelectionPoints(mesh: THREE.Mesh) {
    for (const overlay of [...this.overlays]) {
      if (overlay.parent !== mesh || overlay.userData.kind !== 'point') continue
      overlay.removeFromParent()
      if (overlay instanceof THREE.Mesh) {
        overlay.geometry.dispose()
        ;(overlay.material as THREE.Material).dispose()
      } else if (overlay instanceof THREE.Sprite) {
        overlay.material.map?.dispose()
        overlay.material.dispose()
      }
      this.overlays.delete(overlay)
    }
  }

  private removePreview() {
    if (this.previewLine) {
      this.previewLine.removeFromParent()
      this.previewLine.geometry.dispose()
      ;(this.previewLine.material as THREE.Material).dispose()
    }
    this.previewLine = undefined
    this.previewMesh = undefined
    this.previewPath = undefined
  }

  private calculatePath(
    positions: Float32Array,
    indices: Uint32Array,
    start: number,
    end: number,
  ): Promise<Uint32Array> {
    const requestId = ++this.pathRequestId
    const worker = new Worker(new URL('../workers/geodesic.worker.ts', import.meta.url), { type: 'module' })
    this.pathWorker = worker
    return new Promise((resolve, reject) => {
      this.rejectPath = reject
      worker.onmessage = (event: MessageEvent<
        | { type: 'result'; requestId: number; path: ArrayBuffer }
        | { type: 'error'; requestId: number; message: string }
      >) => {
        const message = event.data
        if (message.requestId !== requestId) return
        this.finishPathCalculation(worker)
        if (message.type === 'error') reject(new Error(message.message))
        else resolve(new Uint32Array(message.path))
      }
      worker.onerror = () => {
        this.finishPathCalculation(worker)
        reject(new Error('Surface path worker crashed'))
      }
      worker.postMessage({
        type: 'compute', requestId, positions: positions.buffer, indices: indices.buffer, start, end,
      }, [positions.buffer, indices.buffer])
    })
  }

  private calculateOpening(
    positions: Float32Array,
    indices: Uint32Array,
    path: Uint32Array,
    maximumHalfWidth: number,
  ): Promise<PredictedOpening> {
    this.cancelCutCalculation()
    const requestId = ++this.cutRequestId
    const worker = new Worker(new URL('../workers/cut.worker.ts', import.meta.url), { type: 'module' })
    this.cutWorker = worker
    const transferablePath = new Uint32Array(path)
    return new Promise((resolve, reject) => {
      this.rejectCut = reject
      worker.onmessage = (event: MessageEvent<
        | {
          type: 'result'
          requestId: number
          positions: ArrayBuffer
          closedPositions: ArrayBuffer
          indices: ArrayBuffer
          leftBoundary: ArrayBuffer
          rightBoundary: ArrayBuffer
          affectedTriangles: ArrayBuffer
          newVertices: ArrayBuffer
          removedConstraints: ArrayBuffer
        }
        | { type: 'error'; requestId: number; message: string }
      >) => {
        const message = event.data
        if (message.requestId !== requestId) return
        this.finishCutCalculation(worker)
        if (message.type === 'error') {
          reject(new Error(message.message))
          return
        }
        resolve({
          positions: new Float32Array(message.positions),
          closedPositions: new Float32Array(message.closedPositions),
          indices: new Uint32Array(message.indices),
          leftBoundary: new Uint32Array(message.leftBoundary),
          rightBoundary: new Uint32Array(message.rightBoundary),
          affectedTriangles: new Uint32Array(message.affectedTriangles),
          newVertices: new Uint32Array(message.newVertices),
          removedConstraints: new Uint32Array(message.removedConstraints),
        })
      }
      worker.onerror = () => {
        this.finishCutCalculation(worker)
        reject(new Error('Elastic incision worker crashed'))
      }
      worker.postMessage({
        type: 'open', requestId, positions: positions.buffer, indices: indices.buffer,
        path: transferablePath.buffer, maximumHalfWidth,
      }, [positions.buffer, indices.buffer, transferablePath.buffer])
    })
  }

  private finishPathCalculation(worker: Worker) {
    worker.terminate()
    if (this.pathWorker === worker) this.pathWorker = undefined
    this.rejectPath = undefined
  }

  private cancelPathCalculation() {
    this.pathRequestId++
    this.pathWorker?.terminate()
    this.pathWorker = undefined
    const reject = this.rejectPath
    this.rejectPath = undefined
    reject?.(new DOMException('Surface path calculation cancelled', 'AbortError'))
  }

  private finishCutCalculation(worker: Worker) {
    worker.terminate()
    if (this.cutWorker === worker) this.cutWorker = undefined
    this.rejectCut = undefined
  }

  private cancelCutCalculation() {
    this.cutRequestId++
    this.cutWorker?.terminate()
    this.cutWorker = undefined
    const reject = this.rejectCut
    this.rejectCut = undefined
    reject?.(new DOMException('Elastic incision calculation cancelled', 'AbortError'))
  }

  private ensureState(mesh: THREE.Mesh, positions: Float32Array, indices: Uint32Array) {
    let state = this.states.get(mesh)
    if (!state) {
      state = new ObjectSimulationState(positions, indices, 1)
      this.states.set(mesh, state)
    }
    return state
  }
}
