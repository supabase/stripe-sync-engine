import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig, SetupResult } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'

export function createSetupActivity(context: ActivitiesContext) {
  return async function setup(config: PipelineConfig): Promise<SetupResult> {
    const engine = createRemoteEngine(context.engineUrl)
    return await engine.pipeline_setup(config)
  }
}
