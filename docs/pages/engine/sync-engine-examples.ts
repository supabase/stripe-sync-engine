// Sync Engine — Minimal Examples
//
// Exports source, destination, and transforms as named objects.
// Each can be invoked via the CLI wrapper and composed with Unix pipes:
//
//   CLI="npx tsx ../../packages/ts-cli/src/index.ts ./sync-engine-examples"
//   $CLI source read | $CLI filterAdmins | $CLI destination write

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  CatalogMessage,
  DataMessage,
  DestinationOutput,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  Stream,
} from './sync-engine-types'

// MARK: - Source

const usersStream: Stream = {
  name: 'users',
  primary_key: [['id']],
}

const users = [
  { id: '1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: '2', name: 'Bob', email: 'bob@example.com', role: 'user' },
  { id: '3', name: 'Charlie', email: 'charlie@example.com', role: 'admin' },
  { id: '4', name: 'Diana', email: 'diana@example.com', role: 'user' },
  { id: '5', name: 'Eve', email: 'eve@example.com', role: 'admin' },
]

/** An in-memory source that emits a fixed list of user records. */
export const source: Source = {
  async discover() {
    return { type: 'catalog', streams: [usersStream] }
  },

  async *read() {
    yield { type: 'stream_status', stream: 'users', status: 'started' } as Message

    for (const data of users) {
      yield {
        type: 'record',
        stream: 'users',
        data,
        emitted_at: Date.now(),
      } satisfies RecordMessage
    }

    yield { type: 'stream_status', stream: 'users', status: 'complete' } as Message
    yield { type: 'state', stream: 'users', data: { offset: users.length } } satisfies StateMessage
  },
}

// MARK: - Destination

/**
 * Prints each record to stdout as NDJSON. Passes through state messages.
 *
 * In pipe mode, ts-cli passes stdin as the first arg (no catalog).
 * In supervisor mode, orchestrator passes (catalog, messages).
 * We accept both by detecting whether the first arg is an async iterable.
 */
export const destination = {
  async *write(
    _params: { config?: unknown; catalog?: CatalogMessage },
    $stdin: AsyncIterableIterator<DataMessage>
  ) {
    for await (const msg of $stdin) {
      if (msg.type === 'record') {
        console.log(JSON.stringify(msg))
      }
      if (msg.type === 'state') {
        yield msg satisfies DestinationOutput
      }
    }
  },
}

// MARK: - Transforms (each is a stdin→stdout pipe function)

/** Drop records where data.role !== 'admin'. Passes through non-record messages. */
export async function* filterAdmins(
  messages: AsyncIterableIterator<Message>
): AsyncIterableIterator<Message> {
  for await (const msg of messages) {
    if (msg.type === 'record' && msg.data.role !== 'admin') continue
    yield msg
  }
}

/** Keep only id, name, email on each record. Passes through non-record messages. */
export async function* selectFields(
  messages: AsyncIterableIterator<Message>
): AsyncIterableIterator<Message> {
  const keep = ['id', 'name', 'email']
  for await (const msg of messages) {
    if (msg.type === 'record') {
      const data: Record<string, unknown> = {}
      for (const f of keep) {
        if (f in msg.data) data[f] = msg.data[f]
      }
      yield { ...msg, data }
    } else {
      yield msg
    }
  }
}

// MARK: - Orchestrator
//
// State file path from env or default.
// Set SYNC_STATE_DIR to control where state is persisted.

const STATE_DIR = process.env['SYNC_STATE_DIR'] || process.cwd()
const STATE_FILE = join(STATE_DIR, 'sync-state.json')

function loadState(): StateMessage | undefined {
  if (!existsSync(STATE_FILE)) return undefined
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  return { type: 'state', stream: saved.stream, data: saved.data }
}

function saveState(state: StateMessage): void {
  const payload = { stream: state.stream, data: state.data }
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n')
  console.error(`[state] saved → ${STATE_FILE}`)
}

// ── Pipe stages ─────────────────────────────────────────────────
//
// These are standalone pipe-compatible functions:
//   source read | orchestrator.forward | dest write | orchestrator.collect

/** Get last checkpoint as JSON. Outputs to stdout for $() subshell. */
export function getState() {
  const state = loadState()
  return state?.data ?? null
}

/**
 * Pipe stage: sits between source and destination.
 * Forwards record + state messages to stdout (for destination).
 * Routes log, error, stream_status to stderr.
 */
export async function* forward(
  messages: AsyncIterableIterator<Message>
): AsyncIterableIterator<DataMessage> {
  for await (const msg of messages) {
    if (msg.type === 'record' || msg.type === 'state') {
      yield msg
    } else if (msg.type === 'log') {
      console.error(`[log:${msg.level}] ${msg.message}`)
    } else if (msg.type === 'error') {
      console.error(`[error:${msg.failure_type}] ${msg.message}`)
    } else if (msg.type === 'stream_status') {
      console.error(`[stream:${msg.stream}] ${msg.status}`)
    }
  }
}

/**
 * Pipe stage: sits after destination.
 * Persists state checkpoints to disk. Routes errors/logs to stderr.
 */
export async function* collect(
  output: AsyncIterableIterator<DestinationOutput>
): AsyncIterableIterator<StateMessage> {
  for await (const msg of output) {
    if (msg.type === 'state') {
      saveState(msg)
      yield msg
    } else if (msg.type === 'error') {
      console.error(`[dest:error] ${msg.message}`)
    } else if (msg.type === 'log') {
      console.error(`[dest:log:${msg.level}] ${msg.message}`)
    }
  }
}

// ── Supervisor mode ─────────────────────────────────────────────
//
// Wires source → forward → destination → collect in-process.
// Invoke via ts-cli: `$CLI orchestrator run`

export const orchestrator = {
  async run() {
    const catalog = await source.discover()
    const previousState = loadState()

    if (previousState) {
      console.error(`[state] resuming from ${JSON.stringify(previousState.data)}`)
    }

    // Source → transform → forward
    let messages: AsyncIterableIterator<Message> = source.read(catalog.streams, previousState)
    messages = filterAdmins(messages)
    const dataMessages = forward(messages)

    // Destination → collect
    for await (const _state of collect(destination.write({ catalog }, dataMessages))) {
      // collect handles persistence; nothing else to do here
    }
  },
}
