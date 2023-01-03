import { Pool, QueryResult } from 'pg'
import { getConfig } from './config'

const config = getConfig()
const pool = new Pool({ connectionString: config.DATABASE_URL })

/**
 * Use this inside a route/file
 *
 * @example
 * => import { query } from 'PostgresConnection'
 * => const { rows } = await query('SELECT * FROM users WHERE id = $1', [id])
 */
export const query = (text: string, params?: string[]): Promise<QueryResult> => {
  return pool.query(text, params)
}
