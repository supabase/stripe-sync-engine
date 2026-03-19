import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PostgresDestination } from '../postgresDestination'
import { PostgresDestinationWriter } from '../writer'
import type { PostgresConfig } from '../types'
import type {
  ConfiguredCatalog,
  Destination,
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  StateMessage,
} from '@stripe/sync-protocol'

const stubConfig: PostgresConfig = {
  schema: 'public',
  poolConfig: { connectionString: 'postgresql://localhost/test' },
}

/** Create a mock PostgresDestinationWriter for dependency injection. */
function createMockWriter() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    upsertMany: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    // Unused methods required by the class shape
    pool: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    delete: vi.fn(),
    upsertManyWithTimestampProtection: vi.fn(),
    findMissingEntries: vi.fn(),
    columnExists: vi.fn(),
    deleteRemovedActiveEntitlements: vi.fn(),
    acquireAdvisoryLock: vi.fn(),
    releaseAdvisoryLock: vi.fn(),
    withAdvisoryLock: vi.fn(),
  } as unknown as PostgresDestinationWriter
}

const emptyCatalog: ConfiguredCatalog = { streams: [] }

const catalogWithStream: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'customers',
        primary_key: [['id']],
        metadata: { account_id: 'acct_123' },
      },
      sync_mode: 'full_refresh',
      destination_sync_mode: 'overwrite',
    },
  ],
}

function makeRecord(stream: string, data: Record<string, unknown>): RecordMessage {
  return { type: 'record', stream, data, emitted_at: Date.now() }
}

function makeState(stream: string, data: unknown): StateMessage {
  return { type: 'state', stream, data }
}

/** Helper to create an async iterable from an array of DestinationInput messages. */
async function* toAsyncIter(msgs: DestinationInput[]): AsyncIterable<DestinationInput> {
  for (const msg of msgs) {
    yield msg
  }
}

/** Collect all yielded DestinationOutput messages. */
async function collectOutputs(
  iter: AsyncIterable<DestinationOutput>
): Promise<DestinationOutput[]> {
  const results: DestinationOutput[] = []
  for await (const msg of iter) {
    results.push(msg)
  }
  return results
}

describe('PostgresDestination', () => {
  it('can be constructed with PostgresConfig', () => {
    const mockWriter = createMockWriter()
    const dest = new PostgresDestination(stubConfig, mockWriter)
    expect(dest).toBeInstanceOf(PostgresDestination)
  })

  it('satisfies the Destination interface', () => {
    const mockWriter = createMockWriter()
    const dest: Destination = new PostgresDestination(stubConfig, mockWriter)
    expect(typeof dest.write).toBe('function')
  })

  describe('setup()', () => {
    it('creates schema', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)

      await dest.setup({ config: {}, catalog: emptyCatalog })

      expect(mockWriter.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE SCHEMA IF NOT EXISTS "public"')
      )
    })

    it('creates tables for each configured stream', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)

      await dest.setup({ config: {}, catalog: catalogWithStream })

      const queryCalls = (mockWriter.query as ReturnType<typeof vi.fn>).mock.calls
      const createTableCall = queryCalls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('CREATE TABLE IF NOT EXISTS') &&
          call[0].includes('"customers"')
      )
      expect(createTableCall).toBeDefined()
      expect(createTableCall![0]).toContain('_raw_data')
      expect(createTableCall![0]).toContain('jsonb')
    })
  })

  describe('teardown()', () => {
    it('drops schema CASCADE', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)

      await dest.teardown({ config: {} })

      expect(mockWriter.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP SCHEMA IF EXISTS "public" CASCADE')
      )
      expect(mockWriter.close).toHaveBeenCalled()
    })
  })

  describe('write() -- record scenarios', () => {
    it('upserts RecordMessage data via upsertMany', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customers', { id: 'cus_2', name: 'Bob' }),
      ])

      await collectOutputs(dest.write({ config: {}, catalog: catalogWithStream, messages }))

      // Records should be flushed (final flush at end of stream)
      expect(mockWriter.upsertMany).toHaveBeenCalledWith(
        [
          { id: 'cus_1', name: 'Alice' },
          { id: 'cus_2', name: 'Bob' },
        ],
        'customers'
      )
    })

    it('batches inserts with configurable batch size', async () => {
      const mockWriter = createMockWriter()
      const config: PostgresConfig = { ...stubConfig, batchSize: 2 }
      const dest = new PostgresDestination(config, mockWriter)
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1' }),
        makeRecord('customers', { id: 'cus_2' }),
        makeRecord('customers', { id: 'cus_3' }),
        makeRecord('customers', { id: 'cus_4' }),
        makeRecord('customers', { id: 'cus_5' }),
      ])

      await collectOutputs(dest.write({ config: {}, catalog: catalogWithStream, messages }))

      // Should flush at record 2, record 4, then remaining 1 at end
      const upsertCalls = (mockWriter.upsertMany as ReturnType<typeof vi.fn>).mock.calls
      expect(upsertCalls).toHaveLength(3)
      expect(upsertCalls[0]![0]).toHaveLength(2) // records 1-2
      expect(upsertCalls[1]![0]).toHaveLength(2) // records 3-4
      expect(upsertCalls[2]![0]).toHaveLength(1) // record 5
    })

    it('defaults batch size to 100', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)
      // Send 50 records -- should NOT trigger a mid-stream flush (only final)
      const records: RecordMessage[] = Array.from({ length: 50 }, (_, i) =>
        makeRecord('customers', { id: `cus_${i}` })
      )
      const messages = toAsyncIter(records)

      await collectOutputs(dest.write({ config: {}, catalog: catalogWithStream, messages }))

      // Only one flush at the end (50 < 100)
      const upsertCalls = (mockWriter.upsertMany as ReturnType<typeof vi.fn>).mock.calls
      expect(upsertCalls).toHaveLength(1)
      expect(upsertCalls[0]![0]).toHaveLength(50)
    })
  })

  describe('write() -- checkpoint scenarios', () => {
    it('re-emits StateMessage after flushing preceding records', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const stateData = { cursor: 'abc123' }
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customers', { id: 'cus_2', name: 'Bob' }),
        makeState('customers', stateData),
      ])

      const outputs = await collectOutputs(
        dest.write({ config: {}, catalog: catalogWithStream, messages })
      )

      // First output should be the re-emitted StateMessage
      const stateOutputs = outputs.filter((m) => m.type === 'state')
      expect(stateOutputs).toHaveLength(1)
      expect(stateOutputs[0]).toEqual({
        type: 'state',
        stream: 'customers',
        data: stateData,
      })

      // upsertMany should have been called BEFORE the state was yielded
      expect(mockWriter.upsertMany).toHaveBeenCalledWith(
        [
          { id: 'cus_1', name: 'Alice' },
          { id: 'cus_2', name: 'Bob' },
        ],
        'customers'
      )
    })
  })

  describe('write() -- error scenarios', () => {
    it('emits ErrorMessage on upsert connection failure', async () => {
      const mockWriter = createMockWriter()
      ;(mockWriter.upsertMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ECONNREFUSED: connection refused')
      )
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([makeRecord('customers', { id: 'cus_1', name: 'Alice' })])

      const outputs = await collectOutputs(
        dest.write({ config: {}, catalog: catalogWithStream, messages })
      )

      const errorOutputs = outputs.filter((m) => m.type === 'error')
      expect(errorOutputs).toHaveLength(1)
      expect(errorOutputs[0]).toMatchObject({
        type: 'error',
        failure_type: 'transient_error',
        message: expect.stringContaining('ECONNREFUSED'),
      })
    })

    it('emits system_error for non-transient failures', async () => {
      const mockWriter = createMockWriter()
      ;(mockWriter.upsertMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('syntax error at position 42')
      )
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([makeRecord('customers', { id: 'cus_1', name: 'Alice' })])

      const outputs = await collectOutputs(
        dest.write({ config: {}, catalog: catalogWithStream, messages })
      )

      const errorOutputs = outputs.filter((m) => m.type === 'error')
      expect(errorOutputs).toHaveLength(1)
      expect(errorOutputs[0]).toMatchObject({
        type: 'error',
        failure_type: 'system_error',
        message: expect.stringContaining('syntax error'),
      })
    })
  })

  describe('write() -- lifecycle', () => {
    it('closes the writer after completion', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([])

      await collectOutputs(dest.write({ config: {}, catalog: emptyCatalog, messages }))

      expect(mockWriter.close).toHaveBeenCalled()
    })

    it('closes the writer even after an error', async () => {
      const mockWriter = createMockWriter()
      ;(mockWriter.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'))
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([])

      await collectOutputs(dest.write({ config: {}, catalog: emptyCatalog, messages }))

      expect(mockWriter.close).toHaveBeenCalled()
    })

    it('emits a LogMessage on successful completion', async () => {
      const mockWriter = createMockWriter()
      const dest = new PostgresDestination(stubConfig, mockWriter)
      const messages = toAsyncIter([])

      const outputs = await collectOutputs(
        dest.write({ config: {}, catalog: emptyCatalog, messages })
      )

      const logOutputs = outputs.filter((m) => m.type === 'log')
      expect(logOutputs).toHaveLength(1)
      expect(logOutputs[0]).toMatchObject({
        type: 'log',
        level: 'info',
        message: expect.stringContaining('public'),
      })
    })
  })

  describe('architecture purity', () => {
    it('destination never imports from or references any source module', async () => {
      // Read the source file and verify no imports from source-stripe
      const fs = await import('fs')
      const path = await import('path')
      const srcDir = path.resolve(__dirname, '..')
      const srcFiles = fs.readdirSync(srcDir).filter((f: string) => f.endsWith('.ts'))

      for (const file of srcFiles) {
        const content = fs.readFileSync(path.join(srcDir, file), 'utf-8')
        expect(content).not.toMatch(/from\s+['"].*source-stripe/)
        expect(content).not.toMatch(/from\s+['"].*@stripe\/source-stripe/)
        expect(content).not.toMatch(/require\(['"].*source-stripe/)
      }
    })
  })
})
