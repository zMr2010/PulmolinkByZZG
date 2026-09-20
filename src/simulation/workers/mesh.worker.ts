interface InitializeMessage {
  type: 'initialize'
  generation: number
  positions: ArrayBuffer
  indices: ArrayBuffer
  anchors: ArrayBuffer
  origin: [number, number, number]
  radius: number
}

interface UpdateMessage {
  type: 'update'
  generation: number
  target: [number, number, number]
}

type WorkerMessage = InitializeMessage | UpdateMessage | { type: 'hold'; generation: number }

let generation = 0
let base = new Float32Array()
let anchors = new Uint32Array()
let anchorMask = new Uint8Array()
let dragOrigin: [number, number, number] = [0, 0, 0]
let weights = new Float32Array()
let adjacency: number[][] = []

interface HeapEntry {
  vertex: number
  distance: number
}

class MinHeap {
  private readonly entries: HeapEntry[] = []

  push(entry: HeapEntry) {
    const entries = this.entries
    entries.push(entry)
    let index = entries.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (entries[parent].distance <= entry.distance) break
      entries[index] = entries[parent]
      index = parent
    }
    entries[index] = entry
  }

  pop() {
    const entries = this.entries
    const first = entries[0]
    const last = entries.pop()
    if (!first || !last || entries.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= entries.length) break
      const right = left + 1
      const child = right < entries.length && entries[right].distance < entries[left].distance ? right : left
      if (entries[child].distance >= last.distance) break
      entries[index] = entries[child]
      index = child
    }
    entries[index] = last
    return first
  }

  get size() { return this.entries.length }
}

function sendDeformation(displacement: Float32Array, started: number) {
  const result = new Float32Array(base.length)
  for (let index = 0; index < base.length; index++) result[index] = base[index] + displacement[index]
  self.postMessage(
    { type: 'deformed', generation, positions: result.buffer, stepMs: performance.now() - started },
    { transfer: [result.buffer] },
  )
}

function edgeLength(positions: Float32Array, a: number, b: number) {
  return Math.hypot(
    positions[a * 3] - positions[b * 3],
    positions[a * 3 + 1] - positions[b * 3 + 1],
    positions[a * 3 + 2] - positions[b * 3 + 2],
  )
}

function deformationWeights(
  positions: Float32Array,
  indices: Uint32Array,
  sources: Uint32Array,
  radius: number,
) {
  const weightedAdjacency = Array.from({ length: positions.length / 3 }, () => new Map<number, number>())
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = [indices[index], indices[index + 1], indices[index + 2]]
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const length = edgeLength(positions, a, b)
      weightedAdjacency[a].set(b, length)
      weightedAdjacency[b].set(a, length)
    }
  }
  const distances = new Float32Array(weightedAdjacency.length)
  distances.fill(Number.POSITIVE_INFINITY)
  const queue = new MinHeap()
  for (const source of sources) {
    distances[source] = 0
    queue.push({ vertex: source, distance: 0 })
  }
  while (queue.size) {
    const { vertex: current, distance } = queue.pop() as HeapEntry
    if (distance !== distances[current] || distance > radius) continue
    for (const [next, length] of weightedAdjacency[current]) {
      const candidate = distance + length
      if (candidate >= distances[next] || candidate > radius) continue
      distances[next] = candidate
      queue.push({ vertex: next, distance: candidate })
    }
  }
  const result = new Float32Array(weightedAdjacency.length)
  for (let index = 0; index < result.length; index++) {
    if (!Number.isFinite(distances[index])) continue
    const x = Math.max(0, 1 - distances[index] / radius)
    result[index] = x * x * (3 - 2 * x)
  }
  return {
    weights: result,
    adjacency: weightedAdjacency.map(neighbors => [...neighbors.keys()]),
  }
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'initialize') {
    generation = message.generation
    base = new Float32Array(message.positions)
    const indices = new Uint32Array(message.indices)
    anchors = new Uint32Array(message.anchors)
    if (!anchors.length || [...anchors].some(anchor => anchor >= base.length / 3)) {
      throw new Error('Persistent drag constraint has an invalid anchor')
    }
    anchorMask = new Uint8Array(base.length / 3)
    for (const anchor of anchors) {
      anchorMask[anchor] = 1
    }
    dragOrigin = [...message.origin]
    if (!dragOrigin.every(Number.isFinite)) throw new Error('Persistent drag constraint has an invalid origin')
    const deformation = deformationWeights(base, indices, anchors, message.radius)
    weights = deformation.weights
    adjacency = deformation.adjacency
    self.postMessage({ type: 'ready', generation })
    return
  }
  if (message.generation !== generation || message.type === 'hold') return
  const started = performance.now()
  const delta = [
    message.target[0] - dragOrigin[0],
    message.target[1] - dragOrigin[1],
    message.target[2] - dragOrigin[2],
  ]
  let displacement = new Float32Array(base.length)
  for (let index = 0; index < weights.length; index++) {
    const weight = weights[index]
    if (!weight) continue
    displacement[index * 3] = delta[0] * weight
    displacement[index * 3 + 1] = delta[1] * weight
    displacement[index * 3 + 2] = delta[2] * weight
  }

  // The whole local membrane shares strain while polygon anchors stay exact.
  // Releasing a pointer only commits the constraint; it never springs back.
  for (let iteration = 0; iteration < 10; iteration++) {
    const relaxed = new Float32Array(displacement)
    for (let index = 0; index < weights.length; index++) {
      const weight = weights[index]
      if (!weight || anchorMask[index] || weight > 0.999) continue
      const neighbors = adjacency[index]
      if (!neighbors.length) continue
      for (let axis = 0; axis < 3; axis++) {
        let average = 0
        for (const neighbor of neighbors) average += displacement[neighbor * 3 + axis]
        average /= neighbors.length
        const desired = delta[axis] * weight
        relaxed[index * 3 + axis] = desired * 0.38 + average * 0.62
      }
    }
    displacement = relaxed
  }
  for (const anchor of anchors) {
    displacement[anchor * 3] = delta[0]
    displacement[anchor * 3 + 1] = delta[1]
    displacement[anchor * 3 + 2] = delta[2]
  }
  sendDeformation(displacement, started)
}

export {}
