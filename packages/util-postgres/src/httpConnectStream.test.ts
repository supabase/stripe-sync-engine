import net from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgHttpConnectStreamFactory, withPgConnectProxy } from './httpConnectStream.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('withPgConnectProxy', () => {
  it('returns the original config when PG_PROXY_HOST is not set', () => {
    vi.stubEnv('PG_PROXY_HOST', '')

    const config = { connectionString: 'postgres://user:pass@localhost:5432/mydb' }

    expect(withPgConnectProxy(config)).toBe(config)
  })

  it('adds a stream factory when PG_PROXY_HOST is set', () => {
    vi.stubEnv('PG_PROXY_HOST', 'pg-proxy.example.test')

    const config = { connectionString: 'postgres://user:pass@localhost:5432/mydb' }
    const proxied = withPgConnectProxy(config)

    expect(proxied).not.toBe(config)
    expect(typeof (proxied as { stream?: unknown }).stream).toBe('function')
  })
})

describe('createPgHttpConnectStreamFactory', () => {
  it('tunnels bytes through an HTTP CONNECT proxy', async () => {
    let request = ''
    let handshakeDone = false

    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        if (handshakeDone) {
          socket.write(`echo:${chunk.toString('utf8')}`)
          return
        }

        buffer = Buffer.concat([buffer, chunk])
        const boundary = buffer.indexOf('\r\n\r\n')
        if (boundary === -1) return

        request = buffer.subarray(0, boundary + 4).toString('latin1')
        handshakeDone = true
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\nproxy-ready')

        const leftover = buffer.subarray(boundary + 4)
        if (leftover.length > 0) {
          socket.write(`echo:${leftover.toString('utf8')}`)
        }
      })
    })

    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP server address')
    }

    const stream = createPgHttpConnectStreamFactory({
      proxyHost: '127.0.0.1',
      proxyPort: address.port,
      connectTimeoutMs: 1_000,
    })({ host: 'db.example.com', port: 5432 })

    const chunks: string[] = []
    stream.on('data', (chunk) => {
      chunks.push(chunk.toString('utf8'))
    })

    stream.connect(5432, 'db.example.com')
    await once(stream, 'connect')

    expect(request).toBe(
      'CONNECT db.example.com:5432 HTTP/1.1\r\nHost: db.example.com:5432\r\n\r\n'
    )

    await new Promise<void>((resolve, reject) => {
      stream.write('ping', (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('proxy-ready')
      expect(chunks.join('')).toContain('echo:ping')
    })

    stream.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
