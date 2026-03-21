import fs from 'node:fs'
import readline from 'node:readline'
import type { ConfiguredCatalog, DestinationInput } from '@stripe/protocol'
import type { PostgresConfig } from './types'
import { PostgresDestination } from './postgresDestination'

export interface DestinationCliOptions {
  command: 'write'
  config: string // path to config JSON (connection details)
  catalog: string // path to catalog JSON
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * Read NDJSON lines from stdin, yielding parsed objects.
 */
async function* readNdjsonStdin(): AsyncIterableIterator<DestinationInput> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed) {
      yield JSON.parse(trimmed) as DestinationInput
    }
  }
}

/**
 * CLI entrypoint for destination-postgres.
 *
 * Commands:
 *   write --config <path> --catalog <path>  Read NDJSON from stdin, write to Postgres.
 *                                            Emits DestinationOutput as NDJSON to stdout.
 */
export async function main(opts: DestinationCliOptions): Promise<void> {
  const config = loadJson(opts.config) as PostgresConfig
  const catalog = loadJson(opts.catalog) as ConfiguredCatalog
  const destination = new PostgresDestination(config)

  if (opts.command === 'write') {
    const stdin = readNdjsonStdin()
    const output = destination.write({ config: {}, catalog }, stdin)
    for await (const msg of output) {
      process.stdout.write(JSON.stringify(msg) + '\n')
    }
    return
  }

  throw new Error(`Unknown command: ${opts.command}`)
}
