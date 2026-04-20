import pino from 'pino'

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'source-stripe',
  },
  pino.destination({ dest: 1, sync: false })
)
