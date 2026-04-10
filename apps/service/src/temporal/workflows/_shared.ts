import { defineSignal, proxyActivities } from '@temporalio/workflow'

import type { SyncActivities } from '../activities/index.js'
import { retryPolicy } from '../../lib/utils.js'
import { DesiredStatus } from '../../lib/createSchemas.js'
import { SourceInputMessage } from '@stripe/sync-protocol'

export const sourceInputSignal = defineSignal<[SourceInputMessage]>('source_input')
/** Carries the new desired_status value — workflow updates its local state directly. */
export const desiredStatusSignal = defineSignal<[DesiredStatus]>('desired_status')

export const { pipelineSetup, pipelineTeardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { pipelineSync } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { updatePipelineStatus } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '30s',
  retry: retryPolicy,
})
