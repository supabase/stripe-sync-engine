import { createLogger, type Logger } from '@stripe/sync-logger'

const pretty = process.env.PINO_PRETTY === 'true' || process.env.LOG_PRETTY === 'true'

const transport = pretty
  ? {
      target: import.meta.resolve('pino-pretty'),
      options: { destination: 1 },
    }
  : undefined

export const log: Logger = createLogger({
  name: 'engine',
  transport,
  redact: {
    paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
    censor: '[redacted]',
  },
})
