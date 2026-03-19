import { describe, expect, it } from 'vitest'
import type {
  CatalogMessage,
  Destination,
  DestinationInput,
  DestinationOutput,
  ErrorMessage,
  LogMessage,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  Stream,
} from '@stripe/sync-protocol'
import {
  PostgresOrchestrator,
  PostgresStateManager,
  type Sync,
} from '@stripe/orchestrator-postgres'
import { runPipeline, type PipelineOrchestrator } from '../../pipeline'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an array into an AsyncIterableIterator. */
async function* toAsync<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item
  }
}

// ---------------------------------------------------------------------------
// Mock Source
// ---------------------------------------------------------------------------

/** A mock source that emits a predefined sequence of messages. */
function createMockSource(messages: Message[]): Source {
  return {
    spec() {
      return { connection_specification: {} }
    },
    async check(_config: Record<string, unknown>) {
      return { status: 'succeeded' as const }
    },
    async discover(_config: Record<string, unknown>): Promise<CatalogMessage> {
      return { type: 'catalog', streams: [] }
    },
    read(
      _config: Record<string, unknown>,
      _streams: Stream[],
      _state?: StateMessage[]
    ): AsyncIterableIterator<Message> {
      return toAsync(messages)
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Destination
// ---------------------------------------------------------------------------

/**
 * A mock destination that tracks received messages and re-emits each
 * StateMessage it receives as output (simulating commit-then-checkpoint).
 */
function createMockDestination(): {
  destination: Destination
  received: DestinationInput[]
} {
  const received: DestinationInput[] = []

  const destination: Destination = {
    spec() {
      return { connection_specification: {} }
    },
    async check(_config: Record<string, unknown>) {
      return { status: 'succeeded' as const }
    },
    async *write(
      _config: Record<string, unknown>,
      _catalog: CatalogMessage,
      messages: AsyncIterableIterator<DestinationInput>
    ): AsyncIterableIterator<DestinationOutput> {
      for await (const msg of messages) {
        received.push(msg)
        // After receiving a state message, re-emit it as output
        // (simulates: destination committed the batch, now checkpointing)
        if (msg.type === 'state') {
          yield msg
        }
      }
    },
  }

  return { destination, received }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stubSync: Sync = {
  id: 'sync_pipeline',
  account_id: 'acct_test',
  status: 'active',
  source: { type: 'stripe' },
  destination: { type: 'postgres' },
  streams: [{ name: 'customers' }],
}

/** Stub StateManager -- no pool needed since tested code paths never hit DB. */
const stubStateManager = new PostgresStateManager(
  null as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  { schema: 'public' }
)

const catalog: CatalogMessage = {
  type: 'catalog',
  streams: [{ name: 'customers', primary_key: [['id']] }],
}

const streams: Stream[] = [{ name: 'customers', primary_key: [['id']] }]

const record1: RecordMessage = {
  type: 'record',
  stream: 'customers',
  data: { id: 'cus_1', name: 'Alice' },
  emitted_at: 1000,
}

const record2: RecordMessage = {
  type: 'record',
  stream: 'customers',
  data: { id: 'cus_2', name: 'Bob' },
  emitted_at: 2000,
}

const state1: StateMessage = {
  type: 'state',
  stream: 'customers',
  data: { cursor: '2024-01-01' },
}

const logMsg: LogMessage = {
  type: 'log',
  level: 'info',
  message: 'Sync progress',
}

const errorMsg: ErrorMessage = {
  type: 'error',
  failure_type: 'transient_error',
  message: 'Rate limited',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipeline()', () => {
  /** Helper: create orchestrator implementing PipelineOrchestrator shape. */
  function createOrchestrator(): PipelineOrchestrator {
    return new PostgresOrchestrator(stubSync, stubStateManager)
  }

  it('routes records through source -> forward -> destination -> collect', async () => {
    const sourceMessages: Message[] = [record1, state1, record2]
    const source = createMockSource(sourceMessages)
    const { destination, received } = createMockDestination()
    const orchestrator = createOrchestrator()

    const checkpoints = await runPipeline(source, destination, orchestrator, catalog, streams)

    // Destination received all 3 data messages (records + state)
    expect(received).toHaveLength(3)
    expect(received[0]).toBe(record1)
    expect(received[1]).toBe(state1)
    expect(received[2]).toBe(record2)

    // collect() yielded the state message that destination re-emitted
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toBe(state1)
  })

  it('filters non-data messages from reaching the destination', async () => {
    const sourceMessages: Message[] = [record1, logMsg, errorMsg, record2]
    const source = createMockSource(sourceMessages)
    const { destination, received } = createMockDestination()
    const orchestrator = createOrchestrator()

    await runPipeline(source, destination, orchestrator, catalog, streams)

    // Only record messages reach the destination (log and error are filtered by forward)
    expect(received).toHaveLength(2)
    expect(received[0]).toBe(record1)
    expect(received[1]).toBe(record2)
  })

  it('collects state checkpoints from destination output', async () => {
    const state2: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { cursor: '2024-06-15' },
    }
    const sourceMessages: Message[] = [record1, state1, record2, state2]
    const source = createMockSource(sourceMessages)
    const { destination } = createMockDestination()
    const orchestrator = createOrchestrator()

    const checkpoints = await runPipeline(source, destination, orchestrator, catalog, streams)

    // Both state messages flow through and are collected
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]).toBe(state1)
    expect(checkpoints[1]).toBe(state2)
  })

  it('handles empty source (no messages)', async () => {
    const source = createMockSource([])
    const { destination, received } = createMockDestination()
    const orchestrator = createOrchestrator()

    const checkpoints = await runPipeline(source, destination, orchestrator, catalog, streams)

    expect(received).toHaveLength(0)
    expect(checkpoints).toHaveLength(0)
  })

  it('handles source with only non-data messages', async () => {
    const sourceMessages: Message[] = [logMsg, errorMsg]
    const source = createMockSource(sourceMessages)
    const { destination, received } = createMockDestination()
    const orchestrator = createOrchestrator()

    const checkpoints = await runPipeline(source, destination, orchestrator, catalog, streams)

    // Nothing reaches the destination
    expect(received).toHaveLength(0)
    // No state checkpoints
    expect(checkpoints).toHaveLength(0)
  })

  it('preserves message ordering through the pipeline', async () => {
    const record3: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_3', name: 'Charlie' },
      emitted_at: 3000,
    }
    const state2: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { cursor: '2024-12-31' },
    }
    // Interleave data messages with non-data messages
    const sourceMessages: Message[] = [record1, logMsg, record2, state1, errorMsg, record3, state2]
    const source = createMockSource(sourceMessages)
    const { destination, received } = createMockDestination()
    const orchestrator = createOrchestrator()

    const checkpoints = await runPipeline(source, destination, orchestrator, catalog, streams)

    // Destination receives data messages in original order (non-data filtered out)
    expect(received).toHaveLength(5)
    expect(received[0]).toBe(record1)
    expect(received[1]).toBe(record2)
    expect(received[2]).toBe(state1)
    expect(received[3]).toBe(record3)
    expect(received[4]).toBe(state2)

    // State checkpoints in order
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]).toBe(state1)
    expect(checkpoints[1]).toBe(state2)
  })
})
