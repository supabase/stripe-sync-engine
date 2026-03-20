'use strict'

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const { runMigrationsMock, processEventMock, closeMock, stripeSyncCreateMock } = vi.hoisted(() => {
  const runMigrationsMock = vi.fn()
  const processEventMock = vi.fn()
  const closeMock = vi.fn()
  const stripeSyncCreateMock = vi.fn().mockResolvedValue({
    webhook: {
      processEvent: processEventMock,
    },
    close: closeMock,
  })

  return {
    runMigrationsMock,
    processEventMock,
    closeMock,
    stripeSyncCreateMock,
  }
})

vi.mock('@stripe/sync-engine', () => ({
  runMigrations: runMigrationsMock,
  StripeSync: {
    create: stripeSyncCreateMock,
  },
}))

import { createServer } from '../app'

const setupPayload = {
  merchantId: 'acct_123',
  merchantConfig: {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/postgres',
    stripeSecretKey: 'sk_test_123',
    schemaName: 'stripe_acct_123',
  },
}

describe('internal fastify api', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await createServer()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await server.close()
  })

  test('GET /health returns ok', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  test('POST /setup runs migrations for the provided merchant config', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/setup',
      payload: setupPayload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      merchantId: 'acct_123',
      schemaName: 'stripe_acct_123',
    })
    expect(runMigrationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: setupPayload.merchantConfig.databaseUrl,
        schemaName: setupPayload.merchantConfig.schemaName,
      })
    )
  })

  test('POST /setup rejects malformed payloads', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/setup',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: expect.stringContaining('body must have required property'),
    })
    expect(runMigrationsMock).not.toHaveBeenCalled()
  })

  test('POST /webhook processes a pre-validated event', async () => {
    const event = {
      id: 'evt_123',
      object: 'event',
      type: 'invoice.updated',
      data: {
        object: {
          id: 'in_123',
          object: 'invoice',
        },
      },
    }

    const response = await server.inject({
      method: 'POST',
      url: '/webhook',
      payload: {
        ...setupPayload,
        event,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      merchantId: 'acct_123',
      eventId: 'evt_123',
      eventType: 'invoice.updated',
    })
    expect(stripeSyncCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSecretKey: setupPayload.merchantConfig.stripeSecretKey,
        stripeAccountId: setupPayload.merchantId,
        schemaName: setupPayload.merchantConfig.schemaName,
        poolConfig: expect.objectContaining({
          connectionString: setupPayload.merchantConfig.databaseUrl,
          keepAlive: true,
          max: 10,
        }),
      })
    )
    expect(processEventMock).toHaveBeenCalledWith(event)
    expect(closeMock).toHaveBeenCalled()
  })

  test('POST /webhook surfaces unexpected failures as 500s', async () => {
    stripeSyncCreateMock.mockResolvedValueOnce({
      webhook: {
        processEvent: vi.fn().mockRejectedValueOnce(new Error('boom')),
      },
      close: closeMock,
    })

    const response = await server.inject({
      method: 'POST',
      url: '/webhook',
      payload: {
        ...setupPayload,
        event: {
          id: 'evt_123',
          object: 'event',
          type: 'invoice.updated',
          data: {
            object: {
              id: 'in_123',
              object: 'invoice',
            },
          },
        },
      },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'boom' })
    expect(closeMock).toHaveBeenCalled()
  })
})
