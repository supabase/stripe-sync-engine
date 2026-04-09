export type SyncRunError = {
  message: string
  failure_type?: string
  stream?: string
}

export type ClassifiedSyncErrors = {
  transient: SyncRunError[]
  permanent: SyncRunError[]
}

const PERMANENT_FAILURE_TYPES = new Set(['config_error', 'auth_error'])

export function classifySyncErrors(errors: SyncRunError[]): ClassifiedSyncErrors {
  const transient: SyncRunError[] = []
  const permanent: SyncRunError[] = []

  for (const error of errors) {
    if (PERMANENT_FAILURE_TYPES.has(error.failure_type ?? '')) {
      permanent.push(error)
    } else {
      transient.push(error)
    }
  }

  return { transient, permanent }
}

export function summarizeSyncErrors(errors: SyncRunError[]): string {
  return errors
    .map((error) => {
      const failureType = error.failure_type ?? 'unknown_error'
      const stream = error.stream ? `/${error.stream}` : ''
      return `[${failureType}${stream}] ${error.message}`
    })
    .join('; ')
}
