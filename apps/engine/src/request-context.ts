import { AsyncLocalStorage } from 'node:async_hooks'

export const ENGINE_REQUEST_ID_HEADER = 'engine-request-id'

type EngineRequestContext = {
  engineRequestId: string
}

const storage = new AsyncLocalStorage<EngineRequestContext>()

export function runWithEngineRequestContext<T>(context: EngineRequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getEngineRequestId(): string | undefined {
  return storage.getStore()?.engineRequestId
}
