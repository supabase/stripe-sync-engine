import pino from 'pino'

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'destination-postgres',
  },
  pino.destination({ dest: 2, sync: false })
)
