import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applySurfaceOpacity } from '@/shared/3d/StructureModelManager'

describe('shared 3D surface opacity', () => {
  it('restores opaque skin to the depth-writing render queue', () => {
    const material = new THREE.MeshPhysicalMaterial()
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)

    applySurfaceOpacity(mesh, 0.3)
    expect(material.opacity).toBe(0.3)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.depthTest).toBe(true)
    expect(mesh.renderOrder).toBe(10)

    const transparentVersion = material.version
    applySurfaceOpacity(mesh, 1)
    expect(material.opacity).toBe(1)
    expect(material.transparent).toBe(false)
    expect(material.depthWrite).toBe(true)
    expect(material.depthTest).toBe(true)
    expect(material.version).toBeGreaterThan(transparentVersion)
    expect(mesh.renderOrder).toBe(0)

    mesh.geometry.dispose()
    material.dispose()
  })
})
