import { execSync } from 'child_process'
import type { Message, StateMessage } from '@stripe/stateless-sync'
import {
  createEngineFromParams,
  parseNdjsonChunks,
  createConnectorResolver,
  SyncParams,
} from '@stripe/stateless-sync'
import type { SyncParams as SyncParamsType } from '@stripe/stateless-sync'
import { envPrefix, parseJsonOrFile, mergeConfig } from '@stripe/ts-cli'

const resolver = createConnectorResolver({
  installFn: (pkg) => execSync(`pnpm add ${pkg}`, { stdio: 'inherit' }),
})

/** Parse comma-separated stream names into the streams array format. */
function parseStreams(value: string | undefined): Array<{ name: string }> | undefined {
  if (!value) return undefined
  return value.split(',').map((name) => ({ name: name.trim() }))
}

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

/** Write a single NDJSON line to stdout. */
function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Read NDJSON lines from stdin. */
function readStdin(): AsyncIterable<unknown> {
  return parseNdjsonChunks(process.stdin as AsyncIterable<Buffer>)
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
  const engine = await createEngineFromParams(params, resolver)
  const messages = readStdin() as AsyncIterable<Message>
  for await (const msg of engine.write(messages)) {
    writeLine(msg)
  }
}

export async function runCommand(params: SyncParamsType) {
  const engine = await createEngineFromParams(params, resolver)
  const input = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of engine.run(input)) {
    writeLine(msg as StateMessage)
  }
}
