import { execSync } from 'child_process'
import type { Message, StateMessage } from '@stripe/stateless-sync'
import {
  createEngineFromParams,
  parseNdjson,
  createConnectorResolver,
  SyncParams,
} from '@stripe/stateless-sync'
import type { SyncParams as SyncParamsType } from '@stripe/stateless-sync'

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
  yield* parseNdjson(text)
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
