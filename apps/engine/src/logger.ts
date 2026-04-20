import pino from 'pino'

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
    redact: {
      paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
      censor: '[redacted]',
    },
  },
  destination
)
