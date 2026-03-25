import type { Message } from '@stripe/stateless-sync'
import {
  createEngineFromParams,
  createConnectorResolver,
  forward,
  collect,
  SyncParams,
} from '@stripe/stateless-sync'
import type { SyncParams as SyncParamsType } from '@stripe/stateless-sync'
import { envPrefix, parseJsonOrFile, mergeConfig, parseStreams } from '@stripe/ts-cli'
import { readStdin, writeLine } from '@stripe/ts-cli/ndjson'

const resolver = createConnectorResolver({})

/** Resolve CLI options + env vars + config file into SyncParams. */
export function resolveParams(opts: {
  source?: string
  destination?: string
  sourceConfig?: string
  destinationConfig?: string
  streams?: string
  config?: string
  params?: string
}): SyncParamsType {
  const file = parseJsonOrFile(opts.config)
  const params = parseJsonOrFile(opts.params)

  try {
    return SyncParams.parse({
      source_name: opts.source ?? file.source_name ?? params.source_name,
      destination_name: opts.destination ?? file.destination_name ?? params.destination_name,
      source_config: mergeConfig(
        parseJsonOrFile(opts.sourceConfig),
        envPrefix('SOURCE'),
        file.source_config as Record<string, unknown> | undefined,
        params.source_config as Record<string, unknown> | undefined
      ),
      destination_config: mergeConfig(
        parseJsonOrFile(opts.destinationConfig),
        envPrefix('DESTINATION'),
        file.destination_config as Record<string, unknown> | undefined,
        params.destination_config as Record<string, unknown> | undefined
      ),
      streams: parseStreams(opts.streams) ?? file.streams ?? params.streams,
      state: file.state ?? params.state,
    })
  } catch {
    console.error('Failed to resolve sync params — check your options and config')
    process.exit(1)
  }
}

// MARK: - Commands

export async function setupCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  await engine.setup()
  console.error('Setup complete.')
}

export async function teardownCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  await engine.teardown()
  console.error('Teardown complete.')
}

export async function checkCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  const result = await engine.check()
  writeLine(result)
}

export async function readCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  const input = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of engine.read(input)) {
    writeLine(msg)
  }
}

export async function writeCommand(params: SyncParamsType) {
  // write only needs the destination — don't resolve the source
  const destination = await resolver.resolveDestination(params.destination_name)
  const destConfig = (params.destination_config ?? {}) as Record<string, unknown>

  // Build a synthetic catalog from --streams (or empty if not provided)
  const catalog = {
    streams: (params.streams ?? []).map((s) => ({
      stream: { name: s.name, primary_key: [['id']] },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append' as const,
    })),
  }

  const callbacks = {
    onLog: (message: string, level: string) => console.error(`[${level}] ${message}`),
    onError: (message: string, failureType: string) =>
      console.error(`[error:${failureType}] ${message}`),
    onStreamStatus: (stream: string, status: string) =>
      console.error(`[status] ${stream}: ${status}`),
  }

  const messages = readStdin() as AsyncIterable<Message>
  const forwarded = forward(messages, callbacks)
  const output = destination.write({ config: destConfig, catalog }, forwarded)

  for await (const msg of collect(output)) {
    writeLine(msg)
  }
}

export async function runCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  const input = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of engine.run(input)) {
    writeLine(msg)
  }
}
