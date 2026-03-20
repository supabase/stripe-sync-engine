import { config } from 'dotenv'
import type { ConnectionOptions } from 'node:tls'

config()

function getStringFromEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

export type FastifyServerRuntimeConfig = {
  port: number
  maxPostgresConnections: number
  sslConnectionOptions?: ConnectionOptions
}

export function getServerConfig(): FastifyServerRuntimeConfig {
  return {
    port: Number(getStringFromEnv('PORT', '8080')),
    maxPostgresConnections: Number(getStringFromEnv('MAX_POSTGRES_CONNECTIONS', '10')),
    sslConnectionOptions: sslConnnectionOptionsFromEnv(),
  }
}

function sslConnnectionOptionsFromEnv(): ConnectionOptions | undefined {
  const pgSslConfigEnabled = getStringFromEnv('PG_SSL_CONFIG_ENABLED', 'false') === 'true'
  const pgSslRejectedUnauthorized =
    getStringFromEnv('PG_SSL_REJECT_UNAUTHORIZED', 'false') === 'true'
  const pgSslCa = getStringFromEnv('PG_SSL_CA', '')
  const pgSslCert = getStringFromEnv('PG_SSL_CERT', '')
  const pgSslRequestCert = getStringFromEnv('PG_SSL_REQUEST_CERT', 'false') === 'true'

  if (pgSslConfigEnabled) {
    return {
      rejectUnauthorized: pgSslRejectedUnauthorized,
      ca: pgSslCa ? pgSslCa : undefined,
      requestCert: pgSslRequestCert,
      cert: pgSslCert ? pgSslCert : undefined,
    }
  } else {
    return undefined
  }
}
