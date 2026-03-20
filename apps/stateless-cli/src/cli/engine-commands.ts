import { execSync } from 'child_process'
import type { Message, StateMessage } from '@stripe/sync-protocol'
import { createEngine, createConnectorResolver, SyncParams } from '@stripe/sync-protocol'
import type { SyncParams as SyncParamsType } from '@stripe/sync-protocol'

const resolver = createConnectorResolver({
  installFn: (pkg) => execSync(`pnpm add ${pkg}`, { stdio: 'inherit' }),
})

/** Parse --params JSON string into SyncParams. */
export function parseParams(raw: string): SyncParamsType {
  try {
    return SyncParams.parse(JSON.parse(raw))
  } catch {
    console.error('Invalid JSON in --params')
    process.exit(1)
  }
}

/** Resolve source + destination connectors from SyncParams and create an engine. */
async function resolveEngine(params: SyncParamsType) {
  const { source: sourceName, destination: destName, ...engineParams } = params
  const [source, destination] = await Promise.all([
    resolver.resolveSource(sourceName),
    resolver.resolveDestination(destName),
  ])
  return createEngine(engineParams, { source, destination })
}

/** Write a single NDJSON line to stdout. */
function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Read NDJSON lines from stdin. */
async function* readStdin(): AsyncIterable<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return
  for (const line of text.split('\n')) {
    if (line.trim()) yield JSON.parse(line)
  }
}

// MARK: - Commands

export async function setupCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  await engine.setup()
  console.error('Setup complete.')
}

export async function teardownCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  await engine.teardown()
  console.error('Teardown complete.')
}

export async function checkCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  const result = await engine.check()
  writeLine(result)
}

export async function readCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  const input = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of engine.read(input)) {
    writeLine(msg)
  }
}

export async function writeCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  const messages = readStdin() as AsyncIterable<Message>
  for await (const msg of engine.write(messages)) {
    writeLine(msg)
  }
}

export async function runCommand(params: SyncParamsType) {
  const engine = await resolveEngine(params)
  const input = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of engine.run(input)) {
    writeLine(msg as StateMessage)
  }
}
