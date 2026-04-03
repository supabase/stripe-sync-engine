import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'

export function createTeardownActivity(context: ActivitiesContext) {
  return async function teardown(config: PipelineConfig): Promise<void> {
    const engine = createRemoteEngine(context.engineUrl)
    await engine.pipeline_teardown(config)
  }
}
