import { Pool, QueryResult } from 'pg'

let pool: Pool | undefined

// const pool = new Pool({ connectionString: config.DATABASE_URL })

/**
 * Use this inside a route/file
 *
 * @example
 * => import { query } from 'PostgresConnection'

 * => const { rows } = await query('SELECT * FROM users WHERE id = $1', [id])
 */
export const query = (
  text: string,
  databaseURL: string,
  params?: string[]
): Promise<QueryResult> => {
  if (!pool) {
    pool = new Pool({ connectionString: databaseURL })
  }
  return pool.query(text, params)
}
