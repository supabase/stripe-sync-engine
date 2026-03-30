import type { ConnectionOptions } from 'node:tls'

/** Matches `pg` `Client` / `Pool` `ssl` option shape. */
export type PgSslConfig = boolean | ConnectionOptions

/**
 * Map the `sslmode` query parameter from a Postgres connection string to a pg
 * `ssl` option. Defaults to `false` (no SSL) when no sslmode is present — SSL
 * must be opted into explicitly via `sslmode=require` (or `verify-ca`/`verify-full`).
 */
export function sslConfigFromConnectionString(connStr: string): PgSslConfig {
  try {
    const sslmode = new URL(connStr).searchParams.get('sslmode')
    if (sslmode === 'disable') return false
    if (sslmode === 'verify-ca' || sslmode === 'verify-full') return true
    if (sslmode === 'require') return { rejectUnauthorized: false }
    return false
  } catch {
    return false
  }
}
