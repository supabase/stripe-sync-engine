import { createActivitiesContext } from './_shared.js'
import { createUpdatePipelineStatusActivity } from './update-pipeline-status.js'
import { createDiscoverCatalogActivity } from './discover-catalog.js'
import { createReadIntoQueueActivity } from './read-into-queue.js'
import { createPipelineSetupActivity } from './pipeline-setup.js'
import { createPipelineSyncActivity } from './pipeline-sync.js'
import { createPipelineTeardownActivity } from './pipeline-teardown.js'
import { createWriteGoogleSheetsFromQueueActivity } from './write-google-sheets-from-queue.js'
import type { PipelineStore } from '../../lib/stores.js'

export type { RunResult } from './_shared.js'

export function createActivities(opts: {
  engineUrl: string
  kafkaBroker?: string
  pipelineStore: PipelineStore
}) {
  const context = createActivitiesContext(opts)

  return {
    discoverCatalog: createDiscoverCatalogActivity(context),
    pipelineSetup: createPipelineSetupActivity(context),
    pipelineSync: createPipelineSyncActivity(context),
    readIntoQueue: createReadIntoQueueActivity(context),
    writeGoogleSheetsFromQueue: createWriteGoogleSheetsFromQueueActivity(context),
    pipelineTeardown: createPipelineTeardownActivity(context),
    updatePipelineStatus: createUpdatePipelineStatusActivity(context),
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
