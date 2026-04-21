import type pg from 'pg'
import { createLogger } from '@stripe/sync-logger'
import type { Logger } from '@stripe/sync-logger'

export const logger: Logger = createLogger({ name: 'util-postgres' })

function extractSql(args: unknown[]): string | undefined {
  if (typeof args[0] === 'string') return args[0]
  if (args[0] && typeof args[0] === 'object' && 'text' in args[0])
    return (args[0] as { text: string }).text
  return undefined
}

type Queryable = pg.Pool | pg.Client

/**
 * Wrap a pg.Pool or pg.Client so every query is logged with structured fields
 * via the caller's pino logger.
 *
 * - `debug` level: query start and every successful query
 * - `error` level: every failed query
 */
export function withQueryLogging<T extends Queryable>(queryable: T, log: Logger = logger): T {
  const origQuery = queryable.query.bind(queryable) as typeof queryable.query
  let nextQueryId = 1

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(queryable as any).query = async function (...args: unknown[]) {
    const queryId = nextQueryId++
    const sqlText = extractSql(args)
    const sqlLabel = sqlText?.replace(/\s+/g, ' ').slice(0, 300) ?? '(unknown)'
    const start = Date.now()

    log.debug({ event: 'pg_query_start', query_id: queryId, sql: sqlLabel })

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (origQuery as any)(...args)
      log.debug({
        event: 'pg_query',
        query_id: queryId,
        duration_ms: Date.now() - start,
        rows: result?.rowCount ?? 0,
        sql: sqlLabel,
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({
        event: 'pg_query_error',
        query_id: queryId,
        duration_ms: Date.now() - start,
        error: msg,
        sql: sqlLabel,
      })
      throw err
    }
  }
  return queryable
}
