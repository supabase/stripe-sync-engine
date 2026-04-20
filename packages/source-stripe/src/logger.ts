import { createLogger } from '@stripe/sync-logger'
import type { Logger } from '@stripe/sync-logger'

export const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  name: 'source-stripe',
})
