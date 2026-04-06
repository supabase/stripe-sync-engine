import type { PipelineStatus } from '../../lib/createSchemas.js'
import type { ActivitiesContext } from './_shared.js'

export function createUpdatePipelineStatusActivity(context: ActivitiesContext) {
  return async function updatePipelineStatus(
    pipelineId: string,
    status: PipelineStatus
  ): Promise<void> {
    try {
      await context.pipelineStore.update(pipelineId, { status })
    } catch {
      // Pipeline may have been removed — no-op
    }
  }
}
