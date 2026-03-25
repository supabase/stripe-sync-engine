export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
}

export interface SyncActivities {
  setup(syncId: string): Promise<void>
  run(syncId: string, input?: unknown[]): Promise<RunResult>
  teardown(syncId: string): Promise<void>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}
