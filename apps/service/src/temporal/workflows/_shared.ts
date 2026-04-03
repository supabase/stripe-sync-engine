import { defineQuery, defineSignal, proxyActivities } from '@temporalio/workflow'
import type { PipelineConfig } from '@stripe/sync-protocol'

import type { SyncActivities } from '../activities/index.js'
import { retryPolicy } from '../../lib/utils.js'

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

export type Pipeline = PipelineConfig & {
  // Keep `id` on the workflow-local shape for now so configQuery still returns
  // the full pipeline resource expected by the API and queue-backed activities
  // can continue using it as the pipeline key. A cleaner split would derive
  // this from Temporal workflow metadata, but that is a broader refactor.
  id: string
}

export type RowIndex = Record<string, Record<string, number>>

export function toConfig(pipeline: Pipeline): PipelineConfig {
  return {
    source: pipeline.source,
    destination: pipeline.destination,
    streams: pipeline.streams,
  }
}

export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const updateSignal = defineSignal<[Partial<Pipeline>]>('update')
export const deleteSignal = defineSignal('delete')

export const statusQuery = defineQuery<WorkflowStatus>('status')
export const configQuery = defineQuery<Pipeline>('config')
export const stateQuery = defineQuery<Record<string, unknown>>('state')

export const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { syncImmediate, readIntoQueue, writeFromQueue } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog, readIntoQueueWithState, writeGoogleSheetsFromQueue } =
  proxyActivities<SyncActivities>({
    startToCloseTimeout: '10m',
    heartbeatTimeout: '2m',
    retry: retryPolicy,
  })
