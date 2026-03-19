// Sync Engine — Interfaces
//
// Source, Destination, Transform, and Orchestrator. These are the
// programmatic interfaces that implementations conform to. For the
// message types that flow between them, see sync-engine-types.ts.
//
// Each interface supports both in-process (TypeScript) and subprocess
// (stdin/stdout NDJSON) usage.

import type {
  CatalogMessage,
  DestinationInput,
  DestinationOutput,
  Message,
  StateMessage,
  Stream,
} from './sync-engine-types'
import type { Sync } from '../3-sync/sync-types'
import { SyncConfig } from '@stripe/sync-protocol'

// MARK: - Source
//
// In-process sources implement this interface directly.
// Subprocess sources read/write NDJSON on stdin/stdout and a thin
// adapter converts between the two.

/**
 * Reads data from an upstream system by emitting messages.
 *
 * A source can be finite (backfill) or infinite (live/streaming).
 * The same interface covers REST API polling, webhook ingestion,
 * event bridge, Kafka replay, database CDC, etc.
 *
 * Subprocess equivalent:
 *   discover → run source process, collect CatalogMessage from stdout
 *   read    → run source process, stream Message lines from stdout
 */
export interface Source {
  /** Discover available streams. Returns them as a CatalogMessage. */
  discover(): Promise<CatalogMessage>

  /** Emit messages (record, state, log, error, stream_status). Finite for backfill, infinite for live. */
  read(streams: Stream[], state?: StateMessage): AsyncIterableIterator<Message>
}

// MARK: - Destination
//
// In-process destinations implement this interface directly.
// Subprocess destinations read DestinationInputs from stdin and emit
// DestinationOutput on stdout after committing.

/**
 * Writes records into a downstream system.
 *
 * A destination can be a database, spreadsheet, warehouse, Stripe API
 * (e.g. Custom Objects for reverse ETL), Kafka topic, etc.
 *
 * The destination only receives RecordMessage and StateMessage — the
 * orchestrator filters out logs, errors, and status messages before
 * they reach the destination.
 *
 * Subprocess equivalent:
 *   destination write --config config.json --catalog catalog.json
 *   Reads DestinationInput lines from stdin, emits DestinationOutput on stdout.
 */
export interface Destination {
  /**
   * Consume data messages and write records to the downstream system.
   * Yields messages back to the orchestrator: StateMessage after committing,
   * ErrorMessage on write failures, LogMessage for diagnostics.
   */
  write(
    params: { catalog: CatalogMessage },
    $stdin: AsyncIterableIterator<DestinationInput>
  ): AsyncIterableIterator<DestinationOutput>
}

// MARK: - Transform
//
// A transform is a function from message stream → message stream.
// Transforms compose: pipe(filter, rename, buffer) is itself a transform.
//
// In-process transforms implement the Transform interface directly.
// Subprocess transforms are stdin/stdout NDJSON pipes (e.g. jq, custom scripts).

/**
 * Transforms a message stream. Composable — multiple transforms can be
 * chained into a pipeline between source and destination.
 *
 * Because it operates on AsyncIterableIterator, a transform can:
 *   - Filter (drop messages)
 *   - Map (modify records)
 *   - Buffer (batch/window)
 *   - Multiplex (split one stream into many)
 *   - Aggregate (reduce many records into one)
 */
export interface Transform {
  (messages: AsyncIterableIterator<Message>): AsyncIterableIterator<Message>
}

/**
 * Compose transforms left-to-right into a single transform.
 *
 * Example:
 *   const pipeline = compose(
 *       filter_stream('customers'),
 *       select_fields(['id', 'name', 'email']),
 *       rename_stream('customers', 'users'),
 *   );
 *   const output = pipeline(source.read(streams));
 */
export type Compose = (...transforms: Transform[]) => Transform

// MARK: - Orchestrator
//
// Instantiated with a SyncConfig. Supports two modes:
//
// 1. Supervisor mode (`run`):
//    Internally does discover, loads state, spawns source | forward | dest | collect.
//
// 2. Pipe mode (properties + `forward` + `collect`):
//    ts-cli supports dot-path property access, so config slices are just
//    properties on the `sync` object — no getter methods needed.
//
// Env vars:
//   SYNC_CONFIG     Path to sync-config.json (required)
//   SYNC_STATE_DIR  Directory for state files (default: .sync/)
//
// Pipe mode example:
//
//   source read \
//       --config "$(orch sync.source)" \
//       --state "$(orch sync.state)" \
//       | orch forward \
//       | dest write \
//           --config "$(orch sync.destination)" \
//       | orch collect
//
// Supervisor mode:
//
//   orch run   # does everything above in one process

export interface Orchestrator {
  /**
   * The Sync object — config + runtime state in one record.
   * Source/destination config, stream selection, and per-stream
   * checkpoint cursors all live here. `collect` merges incoming
   * StateMessages into `sync.state[stream]` and persists the
   * whole Sync back to disk.
   */
  readonly sync: Sync

  // ── Pipe stages (CLI: forward, collect)

  /**
   * Sits between source and destination in a pipe.
   * Forwards RecordMessage and StateMessage to stdout (for destination).
   * Routes LogMessage, ErrorMessage, StreamStatusMessage to stderr.
   */
  forward(messages: AsyncIterableIterator<Message>): AsyncIterableIterator<DestinationInput>

  /**
   * Sits after destination in a pipe.
   * Reads destination output, persists StateMessage checkpoints to disk.
   * Routes ErrorMessage and LogMessage to stderr.
   */
  collect(output: AsyncIterableIterator<DestinationOutput>): AsyncIterableIterator<StateMessage>

  // ── Supervisor mode (CLI: run)

  /** Run the full sync: discover, load state, spawn pipeline, persist state. */
  run(): Promise<void>

  /** Signal graceful shutdown. */
  stop(): Promise<void>
}

/** Data Plane API */
export interface SyncEngineAPI {
  // MARK: - Credentials

  // check(config: SyncConfig): SyncEngineAPI

  read(config: SyncConfig): AsyncIterable<SyncConfig['state']>

  write(config: SyncConfig): AsyncIterable<SyncConfig['state']>
}
