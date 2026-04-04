import { createRemoteEngine } from '@stripe/sync-engine'
import type { SetupResult } from '@stripe/sync-engine'
import { toConfig } from '../../lib/stores.js'
import type { ActivitiesContext } from './_shared.js'

export function createSetupActivity(context: ActivitiesContext) {
  return async function setup(pipelineId: string): Promise<SetupResult> {
    const pipeline = await context.pipelines.get(pipelineId)
    const config = toConfig(pipeline)
    const engine = createRemoteEngine(context.engineUrl)
    const result = await engine.pipeline_setup(config)
    // Persist any config mutations (e.g. webhook endpoint IDs) back to the store
    if (result.source || result.destination) {
      const patch: Record<string, unknown> = {}
      if (result.source) patch.source = { ...pipeline.source, ...result.source }
      if (result.destination) patch.destination = { ...pipeline.destination, ...result.destination }
      await context.pipelines.update(pipelineId, patch)
    }
    return result
  }
}
