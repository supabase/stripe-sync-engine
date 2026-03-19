export interface OrchestratorCliOptions {
  command: 'run' | 'status'
  syncId: string
  config: string // path to orchestrator config JSON
}

/** CLI entrypoint for orchestrator-postgres. Stub -- not yet wired. */
export async function main(_opts: OrchestratorCliOptions): Promise<void> {
  throw new Error('orchestrator-postgres CLI is not yet implemented')
}
