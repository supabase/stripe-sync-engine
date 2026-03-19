import type {
  ConfiguredCatalog,
  Destination,
  Orchestrator,
  Source,
  StateMessage,
} from '@stripe/sync-protocol'

/**
 * @deprecated Use `Orchestrator` from `@stripe/sync-protocol` instead.
 */
export type PipelineOrchestrator = Pick<Orchestrator, 'forward' | 'collect'>

/**
 * Compose Source + Destination + Orchestrator into a full sync pipeline.
 *
 * Data flow:
 *   source.read(catalog, state)
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
  catalog: ConfiguredCatalog,
  sourceConfig?: Record<string, unknown>,
  destinationConfig?: Record<string, unknown>,
  state?: StateMessage[]
): Promise<StateMessage[]> {
  // 1. Source emits messages
  const sourceMessages = source.read({ config: sourceConfig ?? {}, catalog, state })

  // 2. Orchestrator filters: only RecordMessage + StateMessage reach destination
  const forwarded = orchestrator.forward(sourceMessages)

  // 3. Destination writes records, yields output (StateMessage, LogMessage, ErrorMessage)
  const destOutput = destination.write({
    config: destinationConfig ?? {},
    catalog,
    messages: forwarded,
  })

  // 4. Orchestrator collects: persist state checkpoints, route logs/errors
  const collected = orchestrator.collect(destOutput)

  // 5. Drain the pipeline, collecting all state checkpoints
  const checkpoints: StateMessage[] = []
  for await (const msg of collected) {
    checkpoints.push(msg)
  }

  return checkpoints
}
