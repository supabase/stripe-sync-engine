import type { PipelineConfig } from '@stripe/sync-protocol'
import type { Pipeline } from './createSchemas.js'

export type { Pipeline }

export interface PipelineStore {
  get(id: string): Promise<Pipeline>
  set(id: string, pipeline: Pipeline): Promise<void>
  update(id: string, patch: Partial<Omit<Pipeline, 'id'>>): Promise<Pipeline>
  delete(id: string): Promise<void>
  list(): Promise<Pipeline[]>
}

/** Strip `id` from a Pipeline to produce the PipelineConfig expected by the engine. */
export function toConfig(pipeline: Pipeline): PipelineConfig {
  return {
    source: pipeline.source,
    destination: pipeline.destination,
    streams: pipeline.streams,
  }
}
