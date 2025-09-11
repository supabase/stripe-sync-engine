import { pino, stdTimeFunctions } from 'pino'

export const logger = pino({
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: stdTimeFunctions.isoTime,
})
