import type pg from 'pg'
import { createLogger } from '@stripe/sync-logger'
import type { Logger } from '@stripe/sync-logger'

export const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  name: 'util-postgres',
})

function extractSql(args: unknown[]): string | undefined {
  if (typeof args[0] === 'string') return args[0]
  if (args[0] && typeof args[0] === 'object' && 'text' in args[0])
    return (args[0] as { text: string }).text
  return undefined
}

function extractParams(args: unknown[]): unknown[] | undefined {
  if (Array.isArray(args[1])) return args[1]
  return undefined
}

type Queryable = pg.Pool | pg.Client

/**
 * Wrap a pg.Pool or pg.Client so every query is logged with structured fields
 * via the caller's pino logger.
 *
 * - `debug` level: every successful query (sql, duration, row count, params)
 * - `error` level: every failed query (sql, duration, error message, params)
 */
export function withQueryLogging<T extends Queryable>(queryable: T, log: Logger = logger): T {
  const origQuery = queryable.query.bind(queryable) as typeof queryable.query

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(queryable as any).query = async function (...args: unknown[]) {
    const sqlText = extractSql(args)
    const sqlLabel = sqlText?.replace(/\s+/g, ' ').slice(0, 300) ?? '(unknown)'
    const params = extractParams(args)
    const start = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (origQuery as any)(...args)
      log.debug({
        event: 'pg_query',
        duration_ms: Date.now() - start,
        rows: result?.rowCount ?? 0,
        sql: sqlLabel,
        ...(params && { params }),
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({
        event: 'pg_query_error',
        duration_ms: Date.now() - start,
        error: msg,
        sql: sqlLabel,
        ...(params && { params }),
      })
      throw err
    }
  }
  return queryable
}
