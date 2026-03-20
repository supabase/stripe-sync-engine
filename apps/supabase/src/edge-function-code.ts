// @ts-ignore
import setupFunctionCodeRaw from './edge-functions/stripe-setup.ts?raw'
// @ts-ignore
import webhookFunctionCodeRaw from './edge-functions/stripe-webhook.ts?raw'
// @ts-ignore
import workerFunctionCodeRaw from './edge-functions/stripe-worker.ts?raw'
// @ts-ignore
import backfillWorkerFunctionCodeRaw from './edge-functions/stripe-backfill-worker.ts?raw'

export const setupFunctionCode = setupFunctionCodeRaw as string
export const webhookFunctionCode = webhookFunctionCodeRaw as string
export const workerFunctionCode = workerFunctionCodeRaw as string
export const backfillWorkerFunctionCode = backfillWorkerFunctionCodeRaw as string
