import type { DestinationInput, DestinationOutput, Message, StateMessage } from './types'
import type { Destination, Source } from './interfaces'

/**
 * Orchestrator — the third pillar alongside Source and Destination.
 *
 * An orchestrator manages sync lifecycle: discovering catalog, resolving state,
 * routing messages between source and destination, and persisting checkpoints.
 *
 * `TSync` is the orchestrator's sync resource type — the shape of a sync
 * configuration object. Different backends (Postgres, filesystem, in-memory)
 * can use different sync types.
 */
export interface Orchestrator<TSync = unknown> {
  /** The sync configuration this orchestrator is operating on. */
  readonly sync: TSync

  /**
   * Filter source messages for the destination.
   * Forwards RecordMessage and StateMessage; routes logs, errors, and status to callbacks.
   */
  forward(messages: AsyncIterable<Message>): AsyncIterable<DestinationInput>

  /**
   * Process destination output.
   * Persists StateMessage checkpoints; routes logs and errors to callbacks.
   */
  collect(output: AsyncIterable<DestinationOutput>): AsyncIterable<StateMessage>

  /**
   * Run the full sync pipeline: discover, read, forward, write, collect.
   * Returns all state checkpoints collected during the run.
   */
  run(source: Source, destination: Destination): Promise<StateMessage[]>

  /**
   * Signal graceful shutdown.
   */
  stop(): Promise<void>
}
