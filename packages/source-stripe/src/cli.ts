import fs from 'node:fs'
import type { ConfiguredCatalog } from '@stripe/sync-protocol'
import source, { type Config, type StripeStreamState } from './backfill'

export interface SourceCliOptions {
  command: 'discover' | 'read'
  config: string // path to config JSON ({ api_key: string })
  catalog?: string // path to catalog JSON (for read)
  state?: string // path to state JSON (for read)
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * CLI entrypoint for source-stripe.
 *
 * Commands:
 *   discover --config <path>  Print CatalogMessage as JSON to stdout.
 *   read --config <path> --catalog <path> [--state <path>]  Stream NDJSON to stdout.
 */
export async function main(opts: SourceCliOptions): Promise<void> {
  const config = loadJson(opts.config) as Config

  if (opts.command === 'discover') {
    const catalog = await source.discover({ config })
    process.stdout.write(JSON.stringify(catalog) + '\n')
    return
  }

  if (opts.command === 'read') {
    if (!opts.catalog) {
      throw new Error('--catalog is required for the read command')
    }
    const catalog = loadJson(opts.catalog) as ConfiguredCatalog
    let state: Record<string, StripeStreamState> | undefined
    if (opts.state) {
      state = loadJson(opts.state) as Record<string, StripeStreamState>
    }

    const messages = source.read({ config, catalog, state })
    for await (const msg of messages) {
      process.stdout.write(JSON.stringify(msg) + '\n')
    }
    return
  }

  throw new Error(`Unknown command: ${opts.command}`)
}
