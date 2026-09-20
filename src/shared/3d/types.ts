export type Vec3Tuple = [number, number, number]

export type Medical3DPhysicsMode = 'SOFT_BODY' | 'KINEMATIC' | 'RIGID' | 'STATIC'

export interface Medical3DMaterial {
  color: string
  opacity?: number
  roughness?: number
  metalness?: number
  doubleSided?: boolean
}

export interface Medical3DTransform {
  position?: Vec3Tuple
  rotation?: Vec3Tuple
  scale?: Vec3Tuple
}

export interface Medical3DStructure {
  id: string
  name: string
  type: string
  labelId?: number | null
  visualMesh: string
  physicsMesh?: string | null
  binding?: string | null
  nodeNames?: string[]
  deformable: boolean
  visible: boolean
  physicsMode: Medical3DPhysicsMode
  materialProfile?: string | null
  material: Medical3DMaterial
  transform?: Medical3DTransform
  metadata: Record<string, unknown>
}

export interface Medical3DManifest {
  schemaVersion: '1.0'
  id: string
  caseId: string
  name: string
  coordinateSystem: 'GLTF_Y_UP'
  units: 'meter'
  structures: Medical3DStructure[]
  metadata: Record<string, unknown>
  sourceToSimulation?: number[]
}
