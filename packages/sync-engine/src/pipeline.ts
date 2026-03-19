import type {
  CatalogMessage,
  Destination,
  DestinationInput,
  DestinationOutput,
  Message,
  Source,
  StateMessage,
  Stream,
} from '@stripe/sync-protocol'

/**
 * Orchestrator shape required by the pipeline.
 * Duck-typed so we don't couple to PostgresOrchestrator directly.
 */
export interface PipelineOrchestrator {
  forward(messages: AsyncIterableIterator<Message>): AsyncIterableIterator<DestinationInput>
  collect(output: AsyncIterableIterator<DestinationOutput>): AsyncIterableIterator<StateMessage>
}

/**
 * Compose Source + Destination + Orchestrator into a full sync pipeline.
 *
 * Data flow:
 *   source.read(streams, state)
 *     | orchestrator.forward()    -- filter to RecordMessage + StateMessage
 *     | destination.write(catalog) -- write records, yield StateMessage on commit
 *     | orchestrator.collect()    -- persist checkpoints, yield final states
 *
 * Returns all StateMessage checkpoints collected during the pipeline run.
 */
export async function runPipeline(
  source: Source,
  destination: Destination,
  orchestrator: PipelineOrchestrator,
  catalog: CatalogMessage,
  streams: Stream[],
  state?: StateMessage[]
): Promise<StateMessage[]> {
  // 1. Source emits messages
  const sourceMessages = source.read(streams, state)

  // 2. Orchestrator filters: only RecordMessage + StateMessage reach destination
  const forwarded = orchestrator.forward(sourceMessages)

  // 3. Destination writes records, yields output (StateMessage, LogMessage, ErrorMessage)
  const destOutput = destination.write(catalog, forwarded)

  // 4. Orchestrator collects: persist state checkpoints, route logs/errors
  const collected = orchestrator.collect(destOutput)

  // 5. Drain the pipeline, collecting all state checkpoints
  const checkpoints: StateMessage[] = []
  for await (const msg of collected) {
    checkpoints.push(msg)
  }

  return checkpoints
}
