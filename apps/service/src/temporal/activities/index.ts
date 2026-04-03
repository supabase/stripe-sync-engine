import { createActivitiesContext } from './_shared.js'
import { createDiscoverCatalogActivity } from './discover-catalog.js'
import { createReadIntoQueueActivity } from './read-into-queue.js'
import { createReadIntoQueueWithStateActivity } from './read-into-queue-with-state.js'
import { createSetupActivity } from './setup.js'
import { createSyncImmediateActivity } from './sync-immediate.js'
import { createTeardownActivity } from './teardown.js'
import { createWriteFromQueueActivity } from './write-from-queue.js'
import { createWriteGoogleSheetsFromQueueActivity } from './write-google-sheets-from-queue.js'

export type { RunResult } from './_shared.js'

export function createActivities(opts: { engineUrl: string; kafkaBroker?: string }) {
  const context = createActivitiesContext(opts)

  return {
    discoverCatalog: createDiscoverCatalogActivity(context),
    setup: createSetupActivity(context),
    syncImmediate: createSyncImmediateActivity(context),
    readIntoQueueWithState: createReadIntoQueueWithStateActivity(context),
    readIntoQueue: createReadIntoQueueActivity(context),
    writeGoogleSheetsFromQueue: createWriteGoogleSheetsFromQueueActivity(context),
    writeFromQueue: createWriteFromQueueActivity(context),
    teardown: createTeardownActivity(context),
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
