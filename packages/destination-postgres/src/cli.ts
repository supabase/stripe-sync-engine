export interface DestinationCliOptions {
  command: 'write'
  config: string // path to config JSON (connection details)
  catalog: string // path to catalog JSON
}

/** CLI entrypoint for destination-postgres. Stub -- not yet wired. */
export async function main(_opts: DestinationCliOptions): Promise<void> {
  throw new Error('destination-postgres CLI is not yet implemented')
}
