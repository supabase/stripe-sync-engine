import { collectMessages } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'
import { log } from '../../logger.js'

export function createPipelineSetupActivity(context: ActivitiesContext) {
  return async function pipelineSetup(pipelineId: string): Promise<void> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    log.info({ pipelineId }, 'pipeline_setup: starting')
    const { messages: controlMsgs } = await collectMessages(
      context.engine.pipeline_setup(config),
      'control'
    )
    log.info({ pipelineId, controlMsgCount: controlMsgs.length }, 'pipeline_setup: complete')
    // Full replacement — connector emits the complete updated config, no merging.
    let sourceConfig: Record<string, unknown> | undefined
    let destConfig: Record<string, unknown> | undefined
    for (const m of controlMsgs) {
      if (m.control.control_type === 'source_config') {
        sourceConfig = m.control.source_config
      } else if (m.control.control_type === 'destination_config') {
        destConfig = m.control.destination_config
      }
    }
    const patch: Record<string, unknown> = {}
    if (sourceConfig) {
      const type = pipeline.source.type
      patch.source = { type, [type]: sourceConfig }
    }
    if (destConfig) {
      const type = pipeline.destination.type
      patch.destination = { type, [type]: destConfig }
    }
    if (Object.keys(patch).length > 0) {
      await context.pipelineStore.update(pipelineId, patch)
    }
  }
}
