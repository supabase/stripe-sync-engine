import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.LOG_PRETTY ? { target: import.meta.resolve('pino-pretty') } : undefined,
  redact: {
    paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
    censor: '[redacted]',
  },
})
