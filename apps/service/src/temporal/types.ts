export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: Record<string, unknown>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

export const CONTINUE_AS_NEW_THRESHOLD = 500
export const EVENT_BATCH_SIZE = 50

export const retryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2.0,
  maximumInterval: '5m',
  maximumAttempts: 10,
} as const

/** Recursive structural equality for plain JSON objects. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bArr = b as unknown[]
    return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]))
  }
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}
