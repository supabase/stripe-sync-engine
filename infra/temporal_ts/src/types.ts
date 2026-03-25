export interface SyncConfig {
  source_name: string
  destination_name: string
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: string }>
  state?: Record<string, unknown>
  phase?: 'setup' | 'backfill' | 'live'
}

export interface SyncResult {
  state: Record<string, unknown>
  all_complete: boolean
  state_count: number
  errors: Array<{ message: string; failure_type: string; stream?: string }>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  state: Record<string, unknown>
  iteration: number
}

export interface SyncActivities {
  setup(config: SyncConfig): Promise<void>
  sync(config: SyncConfig, input?: unknown[]): Promise<SyncResult>
  teardown(config: SyncConfig): Promise<void>
}
