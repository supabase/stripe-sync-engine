export interface SourceCliOptions {
  command: 'discover' | 'read'
  config: string // path to config JSON
  catalog?: string // path to catalog JSON (for read)
  state?: string // path to state JSON (for read)
}

/** CLI entrypoint for source-stripe. Stub -- not yet wired. */
export async function main(_opts: SourceCliOptions): Promise<void> {
  throw new Error('source-stripe CLI is not yet implemented')
}
