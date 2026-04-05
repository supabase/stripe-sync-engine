import { drain } from '@stripe/sync-protocol'
import type { Message } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'

export function createTeardownActivity(context: ActivitiesContext) {
  return async function teardown(pipelineId: string): Promise<void> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    await drain(context.engine.pipeline_teardown(config))
  }
}
