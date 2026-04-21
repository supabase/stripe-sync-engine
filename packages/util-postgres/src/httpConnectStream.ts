import net from 'node:net'
import { Duplex } from 'node:stream'
import { sslConfigFromConnectionString, stripSslParams } from './sslConfigFromConnectionString.js'

type PgTargetConfig = {
  host?: string
  port?: number
}

type PgProxyEnv = Record<string, string | undefined>

type PgProxyOptions = {
  proxyHost: string
  proxyPort: number
  connectTimeoutMs: number
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number
): number {
  const parsed = Number(value ?? defaultValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

class HttpConnectStream extends Duplex {
  private socket: net.Socket | null = null
  private pendingNoDelay = true
  private pendingKeepAliveDelay: number | undefined

  constructor(
    private readonly targetConfig: PgTargetConfig,
    private readonly proxyOptions: PgProxyOptions
  ) {
    super()
  }

  connect(port?: number, host?: string) {
    const socket = net.createConnection({
      host: this.proxyOptions.proxyHost,
      port: this.proxyOptions.proxyPort,
    })

    this.socket = socket
    socket.setNoDelay(this.pendingNoDelay)
    if (this.pendingKeepAliveDelay !== undefined) {
      socket.setKeepAlive(true, this.pendingKeepAliveDelay)
    }

    socket.setTimeout(this.proxyOptions.connectTimeoutMs, () => {
      socket.destroy(new Error('proxy connect timeout'))
    })

    socket.on('error', (error) => this.emit('error', error))
    socket.on('close', () => {
      this.push(null)
      this.emit('close')
    })

    socket.once('connect', () => {
      const targetHost = host ?? this.targetConfig.host
      const targetPort = port ?? this.targetConfig.port ?? 5432

      if (!targetHost) {
        socket.destroy(new Error('pg proxy target host is required'))
        return
      }

      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`
      )
    })

    let response = Buffer.alloc(0)
    const onHandshakeData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk])
      const boundary = response.indexOf('\r\n\r\n')
      if (boundary === -1) return

      socket.off('data', onHandshakeData)
      socket.setTimeout(0)

      const header = response.subarray(0, boundary).toString('latin1')
      const statusLine = header.split('\r\n', 1)[0] ?? ''
      if (!/^HTTP\/\d\.\d 200\b/.test(statusLine)) {
        socket.destroy(new Error(`proxy CONNECT failed: ${statusLine}`))
        return
      }

      const leftover = response.subarray(boundary + 4)
      socket.on('data', (data) => this.push(data))
      if (leftover.length > 0) {
        this.push(leftover)
      }
      this.emit('connect')
    }

    socket.on('data', onHandshakeData)
  }

  setNoDelay(noDelay = true) {
    this.pendingNoDelay = noDelay
    this.socket?.setNoDelay(noDelay)
  }

  setKeepAlive(enabled = false, initialDelay = 0) {
    if (enabled) {
      this.pendingKeepAliveDelay = initialDelay
    } else {
      this.pendingKeepAliveDelay = undefined
    }
    this.socket?.setKeepAlive(enabled, initialDelay)
  }

  setTimeout(timeout: number, callback?: () => void) {
    this.socket?.setTimeout(timeout, callback)
    return this
  }

  ref() {
    this.socket?.ref()
    return this
  }

  unref() {
    this.socket?.unref()
    return this
  }

  _read() {}

  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.socket) {
      callback(new Error('socket not connected'))
      return
    }
    this.socket.write(chunk, encoding, callback)
  }

  _final(callback: (error?: Error | null) => void) {
    this.socket?.end()
    callback()
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.socket?.destroy(error ?? undefined)
    callback(error)
  }
}

export function createPgHttpConnectStreamFactory(options: PgProxyOptions) {
  return (config: PgTargetConfig) => new HttpConnectStream(config, options)
}

function getTargetHost(config: Record<string, unknown>): string | undefined {
  if (typeof config.host === 'string') return config.host
  if (typeof config.connectionString === 'string') {
    try {
      return new URL(config.connectionString).hostname
    } catch {
      return undefined
    }
  }
  return undefined
}

function shouldBypassPgProxy(targetHost: string | undefined, env: PgProxyEnv): boolean {
  if (!targetHost) return false
  const noProxy = env.PG_NO_PROXY?.trim()
  if (!noProxy) return false
  const entries = noProxy.split(',').map((s) => s.trim().toLowerCase())
  return entries.includes(targetHost.toLowerCase())
}

/**
 * Normalize SSL config for a node-postgres connection.
 *
 * node-postgres parses connectionString last (`Object.assign({}, config, parse(connectionString))`),
 * so `sslmode` in the URL always overwrites any `ssl` key on the config object. This function
 * strips SSL params from the connection string and translates `sslmode` to Node.js TLS options,
 * but only when the caller hasn't already set an explicit `ssl` key.
 *
 * Gated by `PG_NORMALIZE_SSL=1` env var. This area has been repeatedly tricky (proxy + SSL +
 * node-postgres interactions) and needs thorough testing across RDS, local Docker, and tunneled
 * connections. Enable it for testing, but verify before making it the default.
 */
export function normalizePgSslConfig<T extends object>(config: T): T {
  if (!process.env.PG_NORMALIZE_SSL) return config
  const raw = config as Record<string, unknown>
  if (typeof raw.connectionString !== 'string') return config

  let result = { ...config, connectionString: stripSslParams(raw.connectionString) } as T
  if (!('ssl' in raw)) {
    const ssl = sslConfigFromConnectionString(raw.connectionString)
    if (ssl !== false) {
      result = { ...result, ssl } as T
    }
  }
  return result
}

export function withPgConnectProxy<T extends object>(config: T, env: PgProxyEnv = process.env): T {
  const normalized = normalizePgSslConfig(config)

  const proxyHost = env.PG_PROXY_HOST?.trim()
  if (!proxyHost) {
    return normalized
  }

  const targetHost = getTargetHost(normalized as Record<string, unknown>)
  if (shouldBypassPgProxy(targetHost, env)) {
    return normalized
  }

  return {
    ...normalized,
    stream: createPgHttpConnectStreamFactory({
      proxyHost,
      proxyPort: parsePositiveInteger('PG_PROXY_PORT', env.PG_PROXY_PORT, 10072),
      connectTimeoutMs: parsePositiveInteger(
        'PG_CONNECT_TIMEOUT_MS',
        env.PG_CONNECT_TIMEOUT_MS,
        10_000
      ),
    }),
  } as T
}
