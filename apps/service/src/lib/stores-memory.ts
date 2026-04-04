import type { Pipeline } from './createSchemas.js'
import type { PipelineStore } from './stores.js'

/** In-memory pipeline store for testing. */
export function memoryPipelineStore(): PipelineStore {
  const data = new Map<string, Pipeline>()
  return {
    async get(id) {
      const pipeline = data.get(id)
      if (!pipeline) throw new Error(`Pipeline not found: ${id}`)
      return pipeline
    },
    async set(id, pipeline) {
      data.set(id, pipeline)
    },
    async update(id, patch) {
      const existing = data.get(id)
      if (!existing) throw new Error(`Pipeline not found: ${id}`)
      const updated = { ...existing, ...patch, id }
      data.set(id, updated)
      return updated
    },
    async delete(id) {
      data.delete(id)
    },
    async list() {
      return [...data.values()]
    },
  }
}
