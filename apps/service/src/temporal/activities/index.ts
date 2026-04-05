import { createActivitiesContext } from './_shared.js'
import { createDiscoverCatalogActivity } from './discover-catalog.js'
import { createReadGoogleSheetsIntoQueueActivity } from './read-google-sheets-into-queue.js'
import { createSetupActivity } from './setup.js'
import { createSyncImmediateActivity } from './sync-immediate.js'
import { createTeardownActivity } from './teardown.js'
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
    setup: createSetupActivity(context),
    syncImmediate: createSyncImmediateActivity(context),
    readGoogleSheetsIntoQueue: createReadGoogleSheetsIntoQueueActivity(context),
    writeGoogleSheetsFromQueue: createWriteGoogleSheetsFromQueueActivity(context),
    teardown: createTeardownActivity(context),
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
