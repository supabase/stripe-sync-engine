import type { ConnectionOptions } from 'node:tls'

/** Matches `pg` `Client` / `Pool` `ssl` option shape. */
export type PgSslConfig = boolean | ConnectionOptions

/**
 * Strips SSL-related query params from a Postgres connection string before
 * passing it to pg. If left in the URL, pg's URL parser overrides any `ssl`
 * object you supply — including the `ca` field.
 */
export function stripSslParams(connStr: string): string {
  try {
    const url = new URL(connStr)
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
      url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return connStr
  }
}

/**
 * Maps the `sslmode` query parameter from a Postgres connection string to a pg
 * `ssl` option. Throws for unrecognised sslmode values instead of silently
 * disabling SSL.
 *
 * @param sslCaPem - PEM-encoded CA certificate. Required for `verify-ca` /
 *   `verify-full` to trust a private CA (e.g. RDS, internal DBs). If omitted
 *   those modes fall back to the Node.js system trust store.
 */
export function sslConfigFromConnectionString(
  connStr: string,
  { sslCaPem }: { sslCaPem?: string } = {}
): PgSslConfig {
  let sslmode: string | null
  try {
    sslmode = new URL(connStr).searchParams.get('sslmode')
  } catch {
    return false
  }
  if (sslmode === null || sslmode === 'disable') return false
  if (sslmode === 'require') return { rejectUnauthorized: false }
  if (sslmode === 'verify-full') {
    return { rejectUnauthorized: true, ...(sslCaPem ? { ca: sslCaPem } : {}) }
  }
  if (sslmode === 'verify-ca') {
    // verify-ca checks CA trust but skips hostname verification — useful when
    // connecting through a proxy or pgbouncer where the hostname doesn't match.
    return {
      rejectUnauthorized: true,
      ...(sslCaPem ? { ca: sslCaPem } : {}),
      checkServerIdentity: () => undefined,
    }
  }
  throw new Error(
    `Unsupported Postgres sslmode "${sslmode}". Use disable, require, verify-ca, or verify-full.`
  )
}
