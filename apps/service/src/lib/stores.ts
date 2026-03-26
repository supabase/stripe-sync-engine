import type { Pipeline, LogEntry } from './schemas.js'

export type { Pipeline, LogEntry }

// MARK: - Store interfaces

export interface StateStore {
  get(pipelineId: string): Promise<Record<string, unknown> | undefined>
  set(pipelineId: string, stream: string, data: unknown): Promise<void>
  clear(pipelineId: string): Promise<void>
  close?(): Promise<void>
}

export interface PipelineStore {
  get(id: string): Promise<Pipeline>
  set(id: string, pipeline: Pipeline): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<Pipeline[]>
}

export interface LogSink {
  /** Fire-and-forget, non-blocking. */
  write(pipelineId: string, entry: LogEntry): void
}
