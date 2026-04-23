import { createLogger } from '@stripe/sync-logger'
import type { Logger } from '@stripe/sync-logger'

export const log: Logger = createLogger({ name: 'destination-postgres' })
