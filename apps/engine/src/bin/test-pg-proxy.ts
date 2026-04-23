import pg from 'pg'
import net from 'node:net'
import {
  withPgConnectProxy,
  sslConfigFromConnectionString,
  stripSslParams,
} from '@stripe/sync-util-postgres'

const connStr = process.env.TEMP_PG_URL!
if (!connStr) {
  console.error('Set TEMP_PG_URL')
  process.exit(1)
}

const host = new URL(connStr).hostname
const proxyHost = process.env.PG_PROXY_HOST ?? '(not set)'
const proxyPort = process.env.PG_PROXY_PORT ?? '(not set)'
const noProxy = process.env.PG_NO_PROXY ?? '(not set)'

console.log(`Target:      ${host}`)
console.log(`Proxy:       ${proxyHost}:${proxyPort}`)
console.log(`PG_NO_PROXY: ${noProxy}`)

const ssl = sslConfigFromConnectionString(connStr)
console.log(`SSL:         ${JSON.stringify(ssl)}`)

const config = withPgConnectProxy({
  connectionString: stripSslParams(connStr),
  ssl,
  connectionTimeoutMillis: 10000,
})

const hasProxy = !!(config as any).stream
console.log(`Proxy active: ${hasProxy}`)

// Step 1: verify raw TCP to proxy works
console.log(`\n--- Step 1: TCP connect to proxy ${proxyHost}:${proxyPort} ---`)
const sock = net.createConnection({
  host: proxyHost === '(not set)' ? 'localhost' : proxyHost,
  port: Number(proxyPort) || 4750,
})
sock.on('connect', () => {
  console.log('TCP to proxy: OK')
  sock.destroy()

  // Step 2: pg connection
  console.log(`\n--- Step 2: pg.Client connect ---`)
  const start = Date.now()
  const client = new pg.Client(config as any)
  client.on('error', (err) => console.error('Client error event:', err.message))

  client
    .connect()
    .then(() => {
      console.log(`Connected in ${Date.now() - start}ms`)
      return client.query('SELECT 1 as ok')
    })
    .then((r) => {
      console.log('Result:', r.rows)
      return client.end()
    })
    .catch((e) => {
      console.error(`Failed after ${Date.now() - start}ms:`, e.message)
      client.end().catch(() => {})
      process.exit(1)
    })
})
sock.on('error', (err) => {
  console.error('TCP to proxy failed:', err.message)
  process.exit(1)
})
