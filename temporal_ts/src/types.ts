export interface SyncConfig {
  source_name: string
  destination_name: string
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: string }>
  cursors?: Record<string, unknown>
  phase?: 'setup' | 'backfill' | 'live'
}

export interface CategorizedMessages {
  records: unknown[]
  states: Array<{ type: 'state'; stream: string; data: unknown }>
  errors: unknown[]
  stream_statuses: Array<{ type: 'stream_status'; stream: string; status: string }>
  messages: unknown[]
}

export interface ProcessEventResult {
  records_written: number
  state: Record<string, unknown>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  cursors: Record<string, unknown>
  iteration: number
}

export interface SyncActivities {
  healthCheck(config: SyncConfig): Promise<unknown>
  sourceSetup(config: SyncConfig): Promise<void>
  destinationSetup(config: SyncConfig): Promise<void>
  backfillPage(config: SyncConfig, stream: string, cursor: unknown): Promise<CategorizedMessages>
  writeBatch(config: SyncConfig, records: unknown[]): Promise<CategorizedMessages>
  processEvent(config: SyncConfig, event: unknown): Promise<ProcessEventResult>
  sourceTeardown(config: SyncConfig): Promise<void>
  destinationTeardown(config: SyncConfig): Promise<void>
}
