import pino from 'pino'
import { getEngineRequestId } from './request-context.js'

const transport = process.env.LOG_PRETTY
  ? {
      target: import.meta.resolve('pino-pretty'),
      options: { destination: 1 },
    }
  : undefined

const destination = transport ? undefined : pino.destination({ dest: 1, sync: false })

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    transport,
    mixin() {
      const engineRequestId = getEngineRequestId()
      return engineRequestId ? { engine_request_id: engineRequestId } : {}
    },
    redact: {
      paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
      censor: '[redacted]',
    },
  },
  destination
)
