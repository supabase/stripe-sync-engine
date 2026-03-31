// @ts-ignore
import setupCodeRaw from './edge-functions/stripe-setup.ts?raw'
// @ts-ignore
import webhookCodeRaw from './edge-functions/stripe-webhook.ts?raw'
// @ts-ignore
import syncCodeRaw from './edge-functions/stripe-sync.ts?raw'

export const setupFunctionCode = setupCodeRaw as string
export const webhookFunctionCode = webhookCodeRaw as string
export const syncFunctionCode = syncCodeRaw as string
