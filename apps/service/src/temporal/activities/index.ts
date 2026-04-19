import { createActivitiesContext } from './_shared.js'
import { createUpdatePipelineStatusActivity } from './update-pipeline-status.js'
import { createDiscoverCatalogActivity } from './discover-catalog.js'
import { createPipelineSetupActivity } from './pipeline-setup.js'
import { createPipelineSyncActivity } from './pipeline-sync.js'
import { createPipelineTeardownActivity } from './pipeline-teardown.js'
import type { PipelineStore } from '../../lib/stores.js'


export function createActivities(opts: { engineUrl: string; pipelineStore: PipelineStore }) {
  const context = createActivitiesContext(opts)

  return {
    discoverCatalog: createDiscoverCatalogActivity(context),
    pipelineSetup: createPipelineSetupActivity(context),
    pipelineSync: createPipelineSyncActivity(context),
    pipelineTeardown: createPipelineTeardownActivity(context),
    updatePipelineStatus: createUpdatePipelineStatusActivity(context),
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
