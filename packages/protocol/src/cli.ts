import { readFileSync } from 'node:fs'
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'
import type { Source, Destination, DestinationInput } from './protocol.js'
import { parseNdjsonChunks, writeLine } from './ndjson.js'

// MARK: - Config parsing

/**
 * Parse a value as inline JSON or read it as a file path.
 * If the string starts with `{` or `[`, parse as JSON inline.
 * Otherwise, treat as a file path and read + parse.
 */
function parseJsonOrFile(value: string): Record<string, unknown> {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  const raw = readFileSync(trimmed, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// MARK: - Type detection

type AnyConnector = Source | Destination

function isSource(c: AnyConnector): c is Source {
  return typeof (c as Source).discover === 'function' && typeof (c as Source).read === 'function'
}

function isDestination(c: AnyConnector): c is Destination {
  return typeof (c as Destination).write === 'function'
}

// MARK: - CLI builder

export interface ConnectorCliOptions {
  /** CLI program name (e.g. 'source-stripe'). */
  name?: string
  /** Zod schema to validate --config against. */
  configSchema?: { parse: (v: unknown) => unknown }
}

function parseConfig(
  raw: string,
  schema?: ConnectorCliOptions['configSchema']
): Record<string, unknown> {
  const config = parseJsonOrFile(raw)
  if (schema) {
    return schema.parse(config) as Record<string, unknown>
  }
  return config
}

/** Stream all messages from an async iterable to stdout as NDJSON. */
async function streamToStdout(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const msg of iter) {
    writeLine(msg)
  }
}

/**
 * Build a citty CommandDef for a connector.
 * All subcommands stream NDJSON to stdout — everything is a stream.
 */
export function createConnectorCli(
  connector: AnyConnector,
  opts?: ConnectorCliOptions
): CommandDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmds: any = {}

  // spec — universal
  cmds['spec'] = defineCommand({
    meta: { name: 'spec', description: 'Print connector specification (NDJSON)' },
    async run() {
      await streamToStdout(connector.spec())
    },
  })

  // check — universal
  cmds['check'] = defineCommand({
    meta: { name: 'check', description: 'Check connector configuration (NDJSON)' },
    args: {
      config: {
        type: 'string',
        required: true,
        description: 'Connector config (inline JSON or file path)',
      },
    },
    async run({ args }) {
      const config = parseConfig(args.config, opts?.configSchema)
      await streamToStdout(connector.check({ config }))
    },
  })

  // setup — optional on both source and destination
  if (typeof connector.setup === 'function') {
    const setupFn = connector.setup.bind(connector)
    cmds['setup'] = defineCommand({
      meta: { name: 'setup', description: 'Provision external resources (NDJSON)' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
        catalog: {
          type: 'string',
          required: true,
          description: 'Configured catalog (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        const catalog = parseJsonOrFile(args.catalog)
        await streamToStdout(setupFn({ config, catalog } as Parameters<typeof setupFn>[0]))
      },
    })
  }

  // teardown — optional on both source and destination
  if (typeof connector.teardown === 'function') {
    const teardownFn = connector.teardown.bind(connector)
    cmds['teardown'] = defineCommand({
      meta: { name: 'teardown', description: 'Clean up external resources (NDJSON)' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        await streamToStdout(teardownFn({ config } as Parameters<typeof teardownFn>[0]))
      },
    })
  }

  // Source-only commands
  if (isSource(connector)) {
    const src = connector

    cmds['discover'] = defineCommand({
      meta: { name: 'discover', description: 'Discover available streams (NDJSON)' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        await streamToStdout(src.discover({ config }))
      },
    })

    cmds['read'] = defineCommand({
      meta: { name: 'read', description: 'Read records from source (NDJSON)' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
        catalog: {
          type: 'string',
          required: true,
          description: 'Configured catalog (inline JSON or file path)',
        },
        state: { type: 'string', description: 'Stream state (inline JSON or file path)' },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        const catalog = parseJsonOrFile(args.catalog)
        const rawState = args.state ? parseJsonOrFile(args.state) : undefined
        // Accept both SourceState { streams, global } and legacy flat state
        const state = rawState
          ? 'streams' in rawState
            ? (rawState as { streams: Record<string, unknown>; global: Record<string, unknown> })
            : { streams: rawState, global: {} }
          : undefined
        await streamToStdout(
          src.read({
            config,
            catalog: catalog as Parameters<typeof src.read>[0]['catalog'],
            state,
          })
        )
      },
    })
  }

  // Destination-only commands
  if (isDestination(connector)) {
    const dest = connector

    cmds['write'] = defineCommand({
      meta: {
        name: 'write',
        description: 'Write records to destination (reads NDJSON from stdin)',
      },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
        catalog: {
          type: 'string',
          required: true,
          description: 'Configured catalog (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        const catalog = parseJsonOrFile(args.catalog)
        const stdin = parseNdjsonChunks<DestinationInput>(process.stdin)
        await streamToStdout(
          dest.write(
            { config, catalog: catalog as Parameters<typeof dest.write>[0]['catalog'] },
            stdin
          )
        )
      },
    })
  }

  return defineCommand({
    meta: { name: opts?.name },
    subCommands: cmds,
  })
}

/**
 * Create and run a connector CLI, parsing process.argv.
 * Catches errors and emits them as trace error messages on stderr before exiting.
 */
export async function runConnectorCli(
  connector: AnyConnector,
  opts?: ConnectorCliOptions
): Promise<void> {
  const program = createConnectorCli(connector, opts)
  try {
    await runMain(program)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const errorMsg = {
      type: 'trace' as const,
      trace: {
        trace_type: 'error' as const,
        error: {
          failure_type: 'system_error' as const,
          message,
          stack_trace: err instanceof Error ? err.stack : undefined,
        },
      },
    }
    process.stderr.write(JSON.stringify(errorMsg) + '\n')
    process.exitCode = 1
  }
}
