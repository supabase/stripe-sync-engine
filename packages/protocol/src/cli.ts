import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import type { Source, Destination, ConnectorSpecification, DestinationInput } from './protocol'
import { parseNdjsonChunks, writeLine } from './ndjson'

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
 * Build a Commander program for a connector.
 * Commands are auto-detected from the connector's methods.
 */
export function createConnectorCli(connector: AnyConnector, opts?: ConnectorCliOptions): Command {
  const program = new Command()
  if (opts?.name) program.name(opts.name)

  // spec — universal
  program
    .command('spec')
    .description('Print connector specification as JSON')
    .action(() => {
      const spec: ConnectorSpecification = connector.spec()
      writeLine(spec)
    })

  // check — universal
  program
    .command('check')
    .description('Validate connector configuration')
    .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
    .action(async (cmdOpts: { config: string }) => {
      const config = parseConfig(cmdOpts.config, opts?.configSchema)
      const result = await connector.check({ config })
      writeLine(result)
      if (result.status === 'failed') process.exitCode = 1
    })

  // setup — optional on both source and destination
  if (typeof connector.setup === 'function') {
    const setupFn = connector.setup.bind(connector)
    program
      .command('setup')
      .description('Provision external resources')
      .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
      .requiredOption('--catalog <json_or_path>', 'Configured catalog (inline JSON or file path)')
      .action(async (cmdOpts: { config: string; catalog: string }) => {
        const config = parseConfig(cmdOpts.config, opts?.configSchema)
        const catalog = parseJsonOrFile(cmdOpts.catalog)
        await setupFn({ config, catalog } as Parameters<typeof setupFn>[0])
        process.stderr.write('Setup complete\n')
      })
  }

  // teardown — optional on both source and destination
  if (typeof connector.teardown === 'function') {
    const teardownFn = connector.teardown.bind(connector)
    program
      .command('teardown')
      .description('Clean up external resources')
      .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
      .action(async (cmdOpts: { config: string }) => {
        const config = parseConfig(cmdOpts.config, opts?.configSchema)
        await teardownFn({ config } as Parameters<typeof teardownFn>[0])
        process.stderr.write('Teardown complete\n')
      })
  }

  // Source-only commands
  if (isSource(connector)) {
    const src = connector

    program
      .command('discover')
      .description('Discover available streams')
      .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
      .action(async (cmdOpts: { config: string }) => {
        const config = parseConfig(cmdOpts.config, opts?.configSchema)
        const catalog = await src.discover({ config })
        writeLine(catalog)
      })

    program
      .command('read')
      .description('Read records from source (emits NDJSON to stdout)')
      .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
      .requiredOption('--catalog <json_or_path>', 'Configured catalog (inline JSON or file path)')
      .option('--state <json_or_path>', 'Stream state (inline JSON or file path)')
      .action(async (cmdOpts: { config: string; catalog: string; state?: string }) => {
        const config = parseConfig(cmdOpts.config, opts?.configSchema)
        const catalog = parseJsonOrFile(cmdOpts.catalog)
        const state = cmdOpts.state ? parseJsonOrFile(cmdOpts.state) : undefined
        const messages = src.read({
          config,
          catalog: catalog as Parameters<typeof src.read>[0]['catalog'],
          state,
        })
        for await (const msg of messages) {
          writeLine(msg)
        }
      })
  }

  // Destination-only commands
  if (isDestination(connector)) {
    const dest = connector

    program
      .command('write')
      .description('Write records to destination (reads NDJSON from stdin)')
      .requiredOption('--config <json_or_path>', 'Connector config (inline JSON or file path)')
      .requiredOption('--catalog <json_or_path>', 'Configured catalog (inline JSON or file path)')
      .action(async (cmdOpts: { config: string; catalog: string }) => {
        const config = parseConfig(cmdOpts.config, opts?.configSchema)
        const catalog = parseJsonOrFile(cmdOpts.catalog)
        const stdin = parseNdjsonChunks<DestinationInput>(process.stdin)
        const output = dest.write(
          { config, catalog: catalog as Parameters<typeof dest.write>[0]['catalog'] },
          stdin
        )
        for await (const msg of output) {
          writeLine(msg)
        }
      })
  }

  return program
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
    await program.parseAsync(process.argv)
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
