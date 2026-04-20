import pino from 'pino'
import { createLogger } from '@stripe/sync-logger'

const transport = process.env.LOG_PRETTY
  ? {
      target: import.meta.resolve('pino-pretty'),
      options: { destination: 1 },
    }
  : undefined

const destination = transport ? undefined : pino.destination({ dest: 1, sync: false })

export const log = createLogger({
  name: 'engine',
  level: process.env.LOG_LEVEL ?? 'info',
  transport,
  redact: {
    paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
    censor: '[redacted]',
  },
  destination,
})
