import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCommand } from 'citty'
import type {
  Source,
  Message,
  StateMessage,
  Destination,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-engine-stateless'
import { createConnectorResolver } from '@stripe/sync-engine-stateless'
import { createCliFromSpec } from '@stripe/sync-ts-cli'
import { createApp } from '../api/app.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

function makeSource(messages: Message[]): Source {
  return {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    discover: async () => ({
      type: 'catalog',
      streams: [{ name: 'customers', primary_key: [['id']] }],
    }),
    read: () => toAsync(messages),
    setup: async () => {},
    teardown: async () => {},
  }
}

function makeDestination(): Destination {
  return {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    write: (
      _params: { config: Record<string, unknown>; catalog: any },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> =>
      (async function* () {
        for await (const msg of $stdin) {
          if (msg.type === 'state') yield msg
        }
      })(),
    setup: async () => {},
    teardown: async () => {},
  }
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'stateful-cli-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

async function seedSync(app: ReturnType<typeof createApp>): Promise<string> {
  const srcRes = await app.request('/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'stripe-api-core', api_key: 'sk_test' }),
  })
  const { id: srcCredId } = await srcRes.json()

  const dstRes = await app.request('/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    }),
  })
  const { id: dstCredId } = await dstRes.json()

  const syncRes = await app.request('/syncs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account_id: 'acct_test',
      status: 'backfilling',
      source: { type: 'stripe-api-core', credential_id: srcCredId },
      destination: { type: 'postgres', credential_id: dstCredId },
    }),
  })
  const { id } = await syncRes.json()
  return id
}

async function makeCli(app: ReturnType<typeof createApp>) {
  const spec = await (await app.fetch(new Request('http://localhost/openapi.json'))).json()
  return createCliFromSpec({
    spec,
    handler: (req) => Promise.resolve(app.fetch(req)),
    exclude: ['health', 'pushWebhook'],
  })
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
    lines.push(String(data))
    return true
  })
  return { lines, restore: () => spy.mockRestore() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stateful CLI commands', () => {
  it('list-syncs outputs seeded syncs as JSON', async () => {
    const app = createApp({
      dataDir,
      connectors: createConnectorResolver({
        sources: { 'stripe-api-core': makeSource([]) },
        destinations: { postgres: makeDestination() },
      }),
    })
    const syncId = await seedSync(app)
    const cli = await makeCli(app)

    const { lines, restore } = captureStdout()
    await runCommand(cli, { rawArgs: ['list-syncs'] })
    restore()

    const parsed = JSON.parse(lines.join(''))
    expect(parsed.data).toHaveLength(1)
    expect(parsed.data[0].id).toBe(syncId)
  })

  it('get-sync <id> returns the sync using a positional argument', async () => {
    const app = createApp({
      dataDir,
      connectors: createConnectorResolver({
        sources: { 'stripe-api-core': makeSource([]) },
        destinations: { postgres: makeDestination() },
      }),
    })
    const syncId = await seedSync(app)
    const cli = await makeCli(app)

    const { lines, restore } = captureStdout()
    await runCommand(cli, { rawArgs: ['get-sync', syncId] })
    restore()

    const parsed = JSON.parse(lines.join(''))
    expect(parsed.id).toBe(syncId)
  })

  it('check-sync <id> outputs source + destination check results', async () => {
    const app = createApp({
      dataDir,
      connectors: createConnectorResolver({
        sources: { 'stripe-api-core': makeSource([]) },
        destinations: { postgres: makeDestination() },
      }),
    })
    const syncId = await seedSync(app)
    const cli = await makeCli(app)

    const { lines, restore } = captureStdout()
    await runCommand(cli, { rawArgs: ['check-sync', syncId] })
    restore()

    const parsed = JSON.parse(lines.join(''))
    expect(parsed.source.status).toBe('succeeded')
    expect(parsed.destination.status).toBe('succeeded')
  })

  it('run-sync <id> streams NDJSON state messages', async () => {
    const stateMsg: StateMessage = { type: 'state', stream: 'customers', data: { cursor: 'x' } }
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'c1' },
      emitted_at: 0,
    }
    const app = createApp({
      dataDir,
      connectors: createConnectorResolver({
        sources: { 'stripe-api-core': makeSource([record, stateMsg]) },
        destinations: { postgres: makeDestination() },
      }),
    })
    const syncId = await seedSync(app)
    const cli = await makeCli(app)

    const { lines, restore } = captureStdout()
    await runCommand(cli, { rawArgs: ['run-sync', syncId] })
    restore()

    const msgs = lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const states = msgs.filter((m: any) => m.type === 'state')
    expect(states.length).toBeGreaterThanOrEqual(1)
  })

  it('write-sync <id> accepts ndjsonBodyStream and streams state messages back', async () => {
    const app = createApp({
      dataDir,
      connectors: createConnectorResolver({
        sources: { 'stripe-api-core': makeSource([]) },
        destinations: { postgres: makeDestination() },
      }),
    })
    const syncId = await seedSync(app)

    const ndjsonInput =
      [
        JSON.stringify({ type: 'record', stream: 'customers', data: { id: 'c1' }, emitted_at: 0 }),
        JSON.stringify({ type: 'state', stream: 'customers', data: { cursor: 'z' } }),
      ].join('\n') + '\n'

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ndjsonInput))
        controller.close()
      },
    })

    const spec = await (await app.fetch(new Request('http://localhost/openapi.json'))).json()
    const cli = createCliFromSpec({
      spec,
      handler: (req) => Promise.resolve(app.fetch(req)),
      exclude: ['health', 'pushWebhook'],
      ndjsonBodyStream: () => stream as ReadableStream,
    })

    const { lines, restore } = captureStdout()
    await runCommand(cli, { rawArgs: ['write-sync', syncId] })
    restore()

    const msgs = lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const states = msgs.filter((m: any) => m.type === 'state')
    expect(states).toHaveLength(1)
    expect(states[0].stream).toBe('customers')
  })
})
