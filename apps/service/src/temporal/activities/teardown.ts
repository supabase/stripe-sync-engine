import { createRemoteEngine } from '@stripe/sync-engine'
import { toConfig } from '../../lib/stores.js'
import type { ActivitiesContext } from './_shared.js'

export function createTeardownActivity(context: ActivitiesContext) {
  return async function teardown(pipelineId: string): Promise<void> {
    const pipeline = await context.pipelines.get(pipelineId)
    const config = toConfig(pipeline)
    const engine = createRemoteEngine(context.engineUrl)
    await engine.pipeline_teardown(config)
  }
}
