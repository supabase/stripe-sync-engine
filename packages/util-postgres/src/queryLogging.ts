import type pg from 'pg'
import pino from 'pino'

const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  pino.destination({ dest: 1, sync: false })
)

/**
 * Wrap a pg.Pool so every query is logged with structured fields at trace level.
 */
export function withQueryLogging<T extends pg.Pool>(pool: T): T {
  if (!logger.isLevelEnabled('trace')) return pool

  const origQuery = pool.query.bind(pool) as typeof pool.query

  function extractSql(args: unknown[]): string | undefined {
    if (typeof args[0] === 'string') return args[0]
    if (args[0] && typeof args[0] === 'object' && 'text' in args[0])
      return (args[0] as { text: string }).text
    return undefined
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pool as any).query = async function (...args: unknown[]) {
    const sql = extractSql(args)
    const label = sql?.replace(/\s+/g, ' ').slice(0, 300) ?? '(unknown)'
    const start = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (origQuery as any)(...args)
      logger.trace({
        event: 'pg_query',
        duration_ms: Date.now() - start,
        rows: result?.rowCount ?? 0,
        sql: label,
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.trace({
        event: 'pg_query_error',
        duration_ms: Date.now() - start,
        error: msg,
        sql: label,
      })
      throw err
    }
  }
  return pool
}
