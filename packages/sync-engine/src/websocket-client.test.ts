import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'
import type { WebhookProcessingResult } from './websocket-client'

type EventHandler = (...args: unknown[]) => void

interface MockWebSocketInstance {
  on: Mock
  send: Mock
  ping: Mock
  close: Mock
  readyState: number
  _handlers: Record<string, EventHandler>
  _triggerOpen: () => void
  _triggerMessage: (data: string) => void
  _triggerClose: (code: number, reason: string) => void
  _triggerError: (error: Error) => void
}

interface MockWebSocketConstructor {
  (...args: unknown[]): MockWebSocketInstance
  OPEN: number
  mock: {
    results: Array<{ value: MockWebSocketInstance }>
  }
}

// Mock WebSocket
vi.mock('ws', () => {
  const MockWebSocket = vi.fn().mockImplementation(() => {
    const handlers: Record<string, EventHandler> = {}
    return {
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers[event] = handler
      }),
      send: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
      readyState: 1, // WebSocket.OPEN
      // Expose handlers for testing
      _handlers: handlers,
      _triggerOpen: () => handlers['open']?.(),
      _triggerMessage: (data: string) => handlers['message']?.(Buffer.from(data)),
      _triggerClose: (code: number, reason: string) =>
        handlers['close']?.(code, Buffer.from(reason)),
      _triggerError: (error: Error) => handlers['error']?.(error),
    } as MockWebSocketInstance
  })
  ;(MockWebSocket as unknown as MockWebSocketConstructor).OPEN = 1
  return { default: MockWebSocket }
})

// Mock fetch for session creation
const mockSessionResponse = {
  websocket_url: 'wss://test.stripe.com/subscribe/acct_123',
  websocket_id: 'cliws_test123',
  websocket_authorized_feature: 'webhook-payloads',
  secret: 'whsec_test_secret_key_12345',
  reconnect_delay: 5,
}

describe('websocket-client', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSessionResponse),
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  describe('createCliSession', () => {
    it('should call Stripe API with correct parameters', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')

      const onEvent = vi.fn()
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      expect(fetch).toHaveBeenCalledWith(
        'https://api.stripe.com/v1/stripecli/sessions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_test_123',
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        })
      )
    })

    it('should throw error on failed session creation', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          text: () => Promise.resolve('Unauthorized'),
        })
      )

      const { createStripeWebSocketClient } = await import('./websocket-client')

      await expect(
        createStripeWebSocketClient({
          stripeApiKey: 'invalid_key',
          onEvent: vi.fn(),
        })
      ).rejects.toThrow('Failed to create CLI session')
    })
  })

  describe('WebSocket connection', () => {
    it('should call onReady when connection opens', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onReady = vi.fn()
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent: vi.fn(),
        onReady,
      })

      // Get the WebSocket instance and trigger open
      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value
      wsInstance._triggerOpen()

      expect(onReady).toHaveBeenCalledWith(mockSessionResponse.secret)
    })

    it('should call onError when WebSocket error occurs', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onError = vi.fn()
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent: vi.fn(),
        onError,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value
      const testError = new Error('Connection failed')
      wsInstance._triggerError(testError)

      expect(onError).toHaveBeenCalledWith(testError)
    })

    it('should call onClose when WebSocket closes', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onClose = vi.fn()
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent: vi.fn(),
        onClose,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value
      wsInstance._triggerClose(1000, 'Normal closure')

      expect(onClose).toHaveBeenCalledWith(1000, 'Normal closure')
    })
  })

  describe('Event handling', () => {
    it('should send ack immediately before processing event', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onEvent = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => setTimeout(resolve, 100))
      })

      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_123',
        webhook_conversation_id: 'conv_123',
        event_payload: JSON.stringify({ type: 'customer.created', id: 'evt_123' }),
        http_headers: {},
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      // Trigger message
      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Ack should be sent immediately (before onEvent resolves)
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"type":"event_ack"'))
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"event_id":"evt_123"'))
    })

    it('should process event through onEvent callback', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onEvent = vi.fn()
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_456',
        webhook_conversation_id: 'conv_456',
        event_payload: JSON.stringify({ type: 'product.created', id: 'evt_456' }),
        http_headers: {},
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(onEvent).toHaveBeenCalledWith(testEvent)
    })

    it('should send webhook_response after processing event with WebhookProcessingResult', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const mockResult: WebhookProcessingResult = {
        status: 200,
        databaseUrl: 'postgres://localhost:5432/test',
        event_type: 'invoice.paid',
        event_id: 'evt_789',
      }

      const onEvent = vi.fn().mockResolvedValue(mockResult)
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_789',
        webhook_conversation_id: 'conv_789',
        event_payload: JSON.stringify({ type: 'invoice.paid', id: 'evt_789' }),
        http_headers: { 'stripe-signature': 'sig_test' },
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10))

      // First call should be event_ack
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"type":"event_ack"'))

      // Second call should be webhook_response with status from result
      expect(wsInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"webhook_response"')
      )
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"status":200'))

      // Body should contain the processing result info
      const secondCall = wsInstance.send.mock.calls[1][0]
      const response = JSON.parse(secondCall)
      const body = JSON.parse(response.body)
      expect(body.event_type).toBe('invoice.paid')
      expect(body.event_id).toBe('evt_789')
      expect(body.database_url).toBe('postgres://localhost:5432/test')
    })

    it('should send webhook_response with default status when onEvent returns void', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onEvent = vi.fn().mockResolvedValue(undefined)
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_void',
        webhook_conversation_id: 'conv_void',
        event_payload: JSON.stringify({ type: 'customer.created', id: 'evt_void' }),
        http_headers: {},
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Should still send webhook_response with default status 200
      expect(wsInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"webhook_response"')
      )
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"status":200'))
    })

    it('should send webhook_response with error when onEvent throws', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const onError = vi.fn()
      const onEvent = vi.fn().mockRejectedValue(new Error('Processing failed'))
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
        onError,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_error',
        webhook_conversation_id: 'conv_error',
        event_payload: JSON.stringify({ type: 'payment_intent.failed', id: 'evt_error' }),
        http_headers: {},
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Should send webhook_response with status 500
      expect(wsInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"webhook_response"')
      )
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"status":500'))

      // Body should contain error
      const secondCall = wsInstance.send.mock.calls[1][0]
      const response = JSON.parse(secondCall)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Processing failed')

      // onError should have been called
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
    })

    it('should include error in response body when WebhookProcessingResult has error', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const mockResult: WebhookProcessingResult = {
        status: 500,
        databaseUrl: 'postgres://localhost:5432/test',
        error: 'Database connection failed',
      }

      const onEvent = vi.fn().mockResolvedValue(mockResult)
      await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent,
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      const testEvent = {
        type: 'webhook',
        webhook_id: 'evt_db_error',
        webhook_conversation_id: 'conv_db_error',
        event_payload: JSON.stringify({ type: 'charge.failed', id: 'evt_db_error' }),
        http_headers: {},
        endpoint: { url: 'https://test.com', status: 'enabled' },
      }

      wsInstance._triggerMessage(JSON.stringify(testEvent))

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Should send webhook_response with status 500 from result
      expect(wsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"status":500'))

      // Body should contain error from result
      const secondCall = wsInstance.send.mock.calls[1][0]
      const response = JSON.parse(secondCall)
      const body = JSON.parse(response.body)
      expect(body.error).toBe('Database connection failed')
      expect(body.database_url).toBe('postgres://localhost:5432/test')
    })
  })

  describe('Client lifecycle', () => {
    it('should close WebSocket when close() is called', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const client = await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent: vi.fn(),
      })

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value

      client.close()

      expect(wsInstance.close).toHaveBeenCalledWith(1000, 'Connection Done')
    })

    it('should return correct connection status', async () => {
      const { createStripeWebSocketClient } = await import('./websocket-client')
      const WebSocket = (await import('ws')).default

      const client = await createStripeWebSocketClient({
        stripeApiKey: 'sk_test_123',
        onEvent: vi.fn(),
      })

      // Initially not connected (open hasn't been triggered)
      expect(client.isConnected()).toBe(false)

      const wsInstance = (WebSocket as unknown as MockWebSocketConstructor).mock.results[0].value
      wsInstance._triggerOpen()

      expect(client.isConnected()).toBe(true)
    })
  })
})
