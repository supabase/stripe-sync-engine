import type pg from 'pg'

const verbose = !!process.env.DANGEROUSLY_VERBOSE_LOGGING

/**
 * Wrap a pg.Pool so every query is logged to stderr when
 * DANGEROUSLY_VERBOSE_LOGGING is enabled.
 * Format: [pg] <ms>ms | rows=<n> | <sql (truncated)>
 */
export function withQueryLogging<T extends pg.Pool>(pool: T): T {
  if (!verbose) return pool

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
      console.error(`[pg] ${Date.now() - start}ms | rows=${result?.rowCount ?? 0} | ${label}`)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pg] ${Date.now() - start}ms | ERROR ${msg} | ${label}`)
      throw err
    }
  }
  return pool
}
