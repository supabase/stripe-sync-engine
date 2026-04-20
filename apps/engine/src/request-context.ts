import { getEngineRequestId, runWithLogContext } from '@stripe/sync-logger'

export const ENGINE_REQUEST_ID_HEADER = 'sync-engine-reueest-id'

type EngineRequestContext = {
  engineRequestId: string
}

export function runWithEngineRequestContext<T>(context: EngineRequestContext, fn: () => T): T {
  return runWithLogContext(context, fn)
}

export { getEngineRequestId }
