import * as THREE from 'three'

export function closedWoundBoundary(left: Uint32Array, right: Uint32Array) {
  if (left.length < 2 || right.length < 2) throw new Error('A wound requires two non-empty seam boundaries')
  const ordered = [...left]
  for (let index = right.length - 2; index > 0; index--) ordered.push(right[index])
  return Uint32Array.from(ordered)
}

export function boundaryPoints(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  boundary: Uint32Array,
) {
  return [...boundary].map(vertexId => new THREE.Vector3().fromBufferAttribute(position, vertexId))
}

export function nearestBoundaryVertexAtFraction(
  positions: Float32Array,
  boundary: Uint32Array,
  fraction: number,
) {
  if (!boundary.length) throw new Error('Cannot map a control onto an empty wound boundary')
  if (boundary.length === 1) return boundary[0]
  const cumulative = new Float32Array(boundary.length)
  let length = 0
  for (let index = 1; index < boundary.length; index++) {
    const previous = boundary[index - 1] * 3
    const current = boundary[index] * 3
    length += Math.hypot(
      positions[current] - positions[previous],
      positions[current + 1] - positions[previous + 1],
      positions[current + 2] - positions[previous + 2],
    )
    cumulative[index] = length
  }
  const target = THREE.MathUtils.clamp(fraction, 0, 1) * length
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < cumulative.length; index++) {
    const distance = Math.abs(cumulative[index] - target)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return boundary[best]
}

export function nearestMergeBoundaryVertex(
  positions: Float32Array,
  boundaries: readonly Uint32Array[],
  candidate: number,
  maximumDistance: number,
) {
  const offset = candidate * 3
  let nearest = candidate
  let nearestDistance = maximumDistance
  for (const boundary of boundaries) {
    for (const vertexId of boundary) {
      const target = vertexId * 3
      const distance = Math.hypot(
        positions[offset] - positions[target],
        positions[offset + 1] - positions[target + 1],
        positions[offset + 2] - positions[target + 2],
      )
      if (distance < nearestDistance) {
        nearest = vertexId
        nearestDistance = distance
      }
    }
  }
  return nearest
}

export function regularOpeningPositions(
  closed: Float32Array,
  fullyOpened: Float32Array,
  openingPercent: number,
) {
  if (closed.length !== fullyOpened.length || closed.length % 3 !== 0) {
    throw new Error('Regular wound opening requires matching packed xyz buffers')
  }
  const scale = THREE.MathUtils.clamp(openingPercent, 0, 100) / 100
  const positions = new Float32Array(closed.length)
  const displacement = new Float32Array(closed.length)
  for (let index = 0; index < closed.length; index++) {
    displacement[index] = fullyOpened[index] - closed[index]
    positions[index] = closed[index] + displacement[index] * scale
  }
  return { positions, displacement, scale }
}

export function woundBoundaryGeometry(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  left: Uint32Array,
  right: Uint32Array,
  tubeRadius: number,
) {
  const points = boundaryPoints(position, closedWoundBoundary(left, right))
  if (points.length < 3) return new THREE.BufferGeometry().setFromPoints(points)
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.45)
  return new THREE.TubeGeometry(curve, Math.max(24, points.length * 3), tubeRadius, 8, true)
}

/**
 * Builds the visible wound edge from the draggable cage vertices themselves.
 * Centripetal Catmull-Rom is interpolating: the rendered edge passes through
 * every polygon control without the large overshoot of a uniform spline.
 */
export function woundControlPolygonGeometry(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  controlVertexIds: Uint32Array,
  tubeRadius: number,
) {
  const points = boundaryPoints(position, controlVertexIds)
  if (points.length < 3) return new THREE.BufferGeometry().setFromPoints(points)
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.45)
  return new THREE.TubeGeometry(curve, Math.max(32, points.length * 8), tubeRadius, 8, true)
}

export function woundSidewallGeometry(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  normal: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  left: Uint32Array,
  right: Uint32Array,
  depth: number,
) {
  const vertices: number[] = []
  const triangles: number[] = []
  const appendStrip = (boundary: Uint32Array) => {
    const start = vertices.length / 3
    for (const vertexId of boundary) {
      const outer = new THREE.Vector3().fromBufferAttribute(position, vertexId)
      const inward = new THREE.Vector3().fromBufferAttribute(normal, vertexId).normalize().multiplyScalar(-depth)
      vertices.push(outer.x, outer.y, outer.z, outer.x + inward.x, outer.y + inward.y, outer.z + inward.z)
    }
    for (let index = 0; index < boundary.length - 1; index++) {
      const outer0 = start + index * 2
      const inner0 = outer0 + 1
      const outer1 = outer0 + 2
      const inner1 = outer0 + 3
      triangles.push(outer0, outer1, inner0, outer1, inner1, inner0)
    }
  }
  appendStrip(left)
  appendStrip(right)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(triangles)
  geometry.computeVertexNormals()
  return geometry
}

/** A real inner surface at the selected incision depth, joining both walls. */
export function woundInteriorGeometry(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  normal: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  left: Uint32Array,
  right: Uint32Array,
  depth: number,
) {
  const count = Math.min(left.length, right.length)
  const vertices = new Float32Array(count * 2 * 3)
  const triangles: number[] = []
  for (let index = 0; index < count; index++) {
    const ids = [left[index], right[index]]
    for (let side = 0; side < 2; side++) {
      const point = new THREE.Vector3().fromBufferAttribute(position, ids[side])
      const inward = new THREE.Vector3().fromBufferAttribute(normal, ids[side]).normalize().multiplyScalar(-depth)
      point.add(inward).toArray(vertices, (index * 2 + side) * 3)
    }
  }
  for (let index = 0; index < count - 1; index++) {
    const left0 = index * 2
    const right0 = left0 + 1
    const left1 = left0 + 2
    const right1 = left0 + 3
    triangles.push(left0, left1, right0, left1, right1, right0)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
  geometry.setIndex(triangles)
  geometry.computeVertexNormals()
  return geometry
}
