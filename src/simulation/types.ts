import type {
  Medical3DManifest,
  Medical3DMaterial,
  Medical3DPhysicsMode,
  Medical3DStructure,
  Medical3DTransform,
  Vec3Tuple as SharedVec3Tuple,
} from '@/shared/3d/types'

export type Vec3Tuple = SharedVec3Tuple
export type Vec4Tuple = [number, number, number, number]

export type PhysicsMode = Medical3DPhysicsMode
export type InteractionMode =
  | 'SELECT_FIRST_POINT'
  | 'SELECT_SECOND_POINT'
  | 'PREVIEW_CUT'
  | 'CUT_PENDING'
  | 'CUT_COMMITTED'
  | 'DRAG'

export type SimulationConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'SYNCING'
  | 'CONNECTED'
  | 'DESYNC'
  | 'RECONNECTING'

export type SimulationResourceStatus =
  | 'PENDING'
  | 'SEGMENTING'
  | 'MESH_PROCESSING'
  | 'READY'
  | 'FAILED'

export type SimulationMaterial = Medical3DMaterial
export type SimulationTransform = Medical3DTransform
export type SimulationStructure = Medical3DStructure
export type SimulationManifest = Medical3DManifest

export interface SurfacePoint {
  structureId: string
  meshId: string
  triangleId: number
  barycentric: Vec3Tuple
  worldPosition: Vec3Tuple
  localPosition: Vec3Tuple
  vertexId: number
}

export interface CutResult {
  leftBoundary: Uint32Array
  rightBoundary: Uint32Array
  affectedTriangles: Uint32Array
  newVertices: Uint32Array
  removedConstraints: Uint32Array
}

export interface SimulationDebugOptions {
  showVisualMesh: boolean
  showPhysicsMesh: boolean
  showTetrahedra: boolean
  showBVH: boolean
  showCutPath: boolean
  showCutBoundary: boolean
  showConstraintPoints: boolean
  showPrediction: boolean
  showAuthoritative: boolean
  showPredictionError: boolean
  showFPS: boolean
  showPhysicsStepTime: boolean
  showSOFATickRate: boolean
  showNetworkRTT: boolean
  showSOFATime: boolean
}

export interface PhysicsBinaryHeader {
  version: number
  positions: Float32Array
  tetrahedra: Uint32Array
  surfaceTriangles: Uint32Array
  visualTetIds: Uint32Array
  visualWeights: Float32Array
}

export interface SimulationPacketMeta {
  sessionId: string
  objectId: string
  sequenceNumber: number
  simulationTick: number
  topologyVersion: number
}

export interface VisualPhysicsBinding {
  tetId: number
  weights: Vec4Tuple
}
