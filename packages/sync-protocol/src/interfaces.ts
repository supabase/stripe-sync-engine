// Sync Engine — Interfaces
//
// Source and Destination. These are the programmatic interfaces that
// implementations conform to. For the message types that flow between
// them, see types.ts.
//
// Both interfaces are generic over TConfig — the connector's configuration
// type. Connectors export a `spec` (Zod schema) alongside the source/dest
// object, so the config type is inferred statically:
//
//   import source, { spec } from '@stripe/source-stripe2'
//   type Config = z.infer<typeof spec>   // ← fully typed
//   source.discover({ config })           // ← config is Config

import type {
  CatalogMessage,
  CheckResult,
  ConfiguredCatalog,
  ConnectorSpecification,
  DestinationInput,
  DestinationOutput,
  Message,
} from './types'

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
 * TConfig is the connector's configuration type, inferred from its Zod spec.
 *
 * Subprocess equivalent:
 *   discover -> run source process, collect CatalogMessage from stdout
 *   read    -> run source process, stream Message lines from stdout
 */
export interface Source<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  /** Return the JSON Schema for this connector's configuration. */
  spec(): ConnectorSpecification

  /** Validate that the provided configuration can connect to the upstream system. */
  check(params: { config: TConfig }): Promise<CheckResult>

  /** Discover available streams. Returns them as a CatalogMessage. */
  discover(params: { config: TConfig }): Promise<CatalogMessage>

  /** Emit messages (record, state, log, error, stream_status). Finite for backfill, infinite for live. */
  read(params: {
    config: TConfig
    catalog: ConfiguredCatalog
    state?: Record<string, unknown>
  }): AsyncIterableIterator<Message>
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
 * TConfig is the connector's configuration type, inferred from its Zod spec.
 *
 * The destination only receives RecordMessage and StateMessage -- the
 * orchestrator filters out logs, errors, and status messages before
 * they reach the destination.
 *
 * Subprocess equivalent:
 *   destination write --config config.json --catalog catalog.json
 *   Reads DestinationInput lines from stdin, emits DestinationOutput on stdout.
 */
export interface Destination<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  /** Return the JSON Schema for this connector's configuration. */
  spec(): ConnectorSpecification

  /** Validate that the provided configuration can connect to the downstream system. */
  check(params: { config: TConfig }): Promise<CheckResult>

  /**
   * Consume data messages and write records to the downstream system.
   * Yields messages back to the orchestrator: StateMessage after committing,
   * ErrorMessage on write failures, LogMessage for diagnostics.
   */
  write(params: {
    config: TConfig
    catalog: ConfiguredCatalog
    messages: AsyncIterableIterator<DestinationInput>
  }): AsyncIterableIterator<DestinationOutput>
}
