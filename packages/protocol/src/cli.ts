import { readFileSync } from 'node:fs'
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'
import type { Source, Destination, ConnectorSpecification, DestinationInput } from './protocol.js'
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

/**
 * Build a citty CommandDef for a connector.
 * Subcommands are auto-detected from the connector's methods.
 */
export function createConnectorCli(
  connector: AnyConnector,
  opts?: ConnectorCliOptions
): CommandDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmds: any = {}

  // spec — universal
  cmds['spec'] = defineCommand({
    meta: { name: 'spec', description: 'Print connector specification as JSON' },
    async run() {
      const spec: ConnectorSpecification = connector.spec()
      writeLine(spec)
    },
  })

  // check — universal
  cmds['check'] = defineCommand({
    meta: { name: 'check', description: 'Validate connector configuration' },
    args: {
      config: {
        type: 'string',
        required: true,
        description: 'Connector config (inline JSON or file path)',
      },
    },
    async run({ args }) {
      const config = parseConfig(args.config, opts?.configSchema)
      const result = await connector.check({ config })
      writeLine(result)
      if (result.status === 'failed') process.exitCode = 1
    },
  })

  // setup — optional on both source and destination
  if (typeof connector.setup === 'function') {
    const setupFn = connector.setup.bind(connector)
    cmds['setup'] = defineCommand({
      meta: { name: 'setup', description: 'Provision external resources' },
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
        await setupFn({ config, catalog } as Parameters<typeof setupFn>[0])
        process.stderr.write('Setup complete\n')
      },
    })
  }

  // teardown — optional on both source and destination
  if (typeof connector.teardown === 'function') {
    const teardownFn = connector.teardown.bind(connector)
    cmds['teardown'] = defineCommand({
      meta: { name: 'teardown', description: 'Clean up external resources' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        await teardownFn({ config } as Parameters<typeof teardownFn>[0])
        process.stderr.write('Teardown complete\n')
      },
    })
  }

  // Source-only commands
  if (isSource(connector)) {
    const src = connector

    cmds['discover'] = defineCommand({
      meta: { name: 'discover', description: 'Discover available streams' },
      args: {
        config: {
          type: 'string',
          required: true,
          description: 'Connector config (inline JSON or file path)',
        },
      },
      async run({ args }) {
        const config = parseConfig(args.config, opts?.configSchema)
        const catalog = await src.discover({ config })
        writeLine(catalog)
      },
    })

    cmds['read'] = defineCommand({
      meta: { name: 'read', description: 'Read records from source (emits NDJSON to stdout)' },
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
        const state = args.state ? parseJsonOrFile(args.state) : undefined
        const messages = src.read({
          config,
          catalog: catalog as Parameters<typeof src.read>[0]['catalog'],
          state,
        })
        for await (const msg of messages) {
          writeLine(msg)
        }
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
        const output = dest.write(
          { config, catalog: catalog as Parameters<typeof dest.write>[0]['catalog'] },
          stdin
        )
        for await (const msg of output) {
          writeLine(msg)
        }
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
 * Catches errors and emits them as ErrorMessage on stderr before exiting.
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
      type: 'error' as const,
      failure_type: 'system_error' as const,
      message,
      stack_trace: err instanceof Error ? err.stack : undefined,
    }
    process.stderr.write(JSON.stringify(errorMsg) + '\n')
    process.exitCode = 1
  }
}
