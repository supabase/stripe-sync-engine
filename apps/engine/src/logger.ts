import { createLogger, type Logger } from '@stripe/sync-logger'

export const log: Logger = createLogger({ name: 'engine' })
