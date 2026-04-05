import { defineQuery, defineSignal, proxyActivities } from '@temporalio/workflow'

import type { SyncActivities } from '../activities/index.js'
import type { SyncState } from '@stripe/sync-protocol'
import { retryPolicy } from '../../lib/utils.js'

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

export type RowIndex = Record<string, Record<string, number>>

export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
/** Signal to control pause/resume. Config changes are written to the store directly. */
export const updateSignal = defineSignal<[{ paused?: boolean }]>('update')
export const deleteSignal = defineSignal('delete')

export const statusQuery = defineQuery<WorkflowStatus>('status')
export const stateQuery = defineQuery<SyncState>('state')

export const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { syncImmediate } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog, readGoogleSheetsIntoQueue, writeGoogleSheetsFromQueue } =
  proxyActivities<SyncActivities>({
    startToCloseTimeout: '10m',
    heartbeatTimeout: '2m',
    retry: retryPolicy,
  })
