import WebSocket from 'ws'
import Stripe from 'stripe'

export interface StripeWebSocketSession {
  websocketUrl: string
  websocketId: string
  websocketAuthorizedFeature: string
  reconnectDelay: number
}

export interface StripeWebSocketClient {
  close: () => Promise<void>
}

export interface StripeWebSocketOptions {
  stripeApiKey: string
  onEvent: (event: Stripe.Event) => void | Promise<void>
  onReady?: () => void
  onError?: (error: Error) => void
  logger?: {
    info: (message: string, data?: unknown) => void
    error: (message: string, error?: unknown) => void
    warn: (message: string, data?: unknown) => void
  }
}

/**
 * Creates a Stripe WebSocket session using the internal stripecli/sessions API.
 *
 * WARNING: This uses an internal Stripe API that is not publicly documented.
 * It mimics the Stripe CLI to access WebSocket-based webhook forwarding.
 * This may break if Stripe changes their internal API.
 */
async function createStripeWebSocketSession(
  apiKey: string,
  logger?: StripeWebSocketOptions['logger']
): Promise<StripeWebSocketSession> {
  logger?.info('Creating Stripe WebSocket session')

  // Build headers that mimic the Stripe CLI
  const clientUserAgent = JSON.stringify({
    name: 'stripe-cli',
    version: '1.19.0',
    publisher: 'stripe',
    os: process.platform,
    uname: `${process.platform} ${process.arch}`,
  })

  const params = new URLSearchParams({
    device_name: 'stripe-sync-engine',
    'websocket_features[]': 'webhooks',
  })

  const response = await fetch('https://api.stripe.com/v1/stripecli/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Stripe/v1 stripe-cli/1.19.0',
      'X-Stripe-Client-User-Agent': clientUserAgent,
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMessage = `Failed to create Stripe WebSocket session: ${response.status} ${response.statusText}`

    try {
      const errorData = JSON.parse(errorText)
      if (errorData.error?.message) {
        errorMessage += ` - ${errorData.error.message}`
      }
    } catch {
      errorMessage += ` - ${errorText}`
    }

    throw new Error(errorMessage)
  }

  const session = (await response.json()) as {
    WebSocketURL?: string
    WebSocketID?: string
    WebSocketAuthorizedFeature?: string
    ReconnectDelay?: number
    websocket_url?: string
    websocket_id?: string
    websocket_authorized_feature?: string
    reconnect_delay?: number
  }

  // Handle both PascalCase and snake_case responses
  const websocketUrl = session.WebSocketURL || session.websocket_url
  const websocketId = session.WebSocketID || session.websocket_id
  const websocketAuthorizedFeature =
    session.WebSocketAuthorizedFeature || session.websocket_authorized_feature
  const reconnectDelay = session.ReconnectDelay || session.reconnect_delay || 5

  if (!websocketUrl || !websocketId || !websocketAuthorizedFeature) {
    throw new Error('Invalid session response: missing required fields')
  }

  logger?.info('Stripe WebSocket session created', {
    websocketId,
    feature: websocketAuthorizedFeature,
  })

  return {
    websocketUrl,
    websocketId,
    websocketAuthorizedFeature,
    reconnectDelay,
  }
}

/**
 * Connects to the Stripe WebSocket and forwards events to the provided callback.
 */
export async function createStripeWebSocketClient(
  options: StripeWebSocketOptions
): Promise<StripeWebSocketClient> {
  const { stripeApiKey, onEvent, onReady, onError, logger } = options

  let ws: WebSocket | null = null
  let isClosing = false
  let reconnectTimeout: NodeJS.Timeout | null = null

  async function connect() {
    if (isClosing) return

    try {
      // Create session
      const session = await createStripeWebSocketSession(stripeApiKey, logger)

      // Build WebSocket URL
      const wsUrl = `${session.websocketUrl}?websocket_feature=${session.websocketAuthorizedFeature}`

      logger?.info('Connecting to Stripe WebSocket', { url: session.websocketUrl })

      // Connect WebSocket
      ws = new WebSocket(wsUrl, {
        headers: {
          'Websocket-Id': session.websocketId,
          'User-Agent': 'Stripe/v1 stripe-cli/1.19.0',
        },
      })

      ws.on('open', () => {
        logger?.info('WebSocket connected - listening for Stripe events')
        onReady?.()
      })

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString())

          // The message format from Stripe WebSocket contains the event
          if (message && typeof message === 'object') {
            // Check if this is a Stripe event
            if (message.type && message.id) {
              await onEvent(message as Stripe.Event)
            } else if (message.event) {
              // Sometimes the event is nested
              await onEvent(message.event as Stripe.Event)
            } else {
              logger?.warn('Received unknown message format', message)
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          logger?.error('Error processing WebSocket message', err)
          onError?.(err)
        }
      })

      ws.on('error', (error) => {
        logger?.error('WebSocket error', error)
        onError?.(error instanceof Error ? error : new Error(String(error)))
      })

      ws.on('close', (code, reason) => {
        logger?.warn('WebSocket closed', { code, reason: reason.toString() })

        if (!isClosing) {
          // Reconnect after delay
          const delay = session.reconnectDelay * 1000
          logger?.info(`Reconnecting in ${session.reconnectDelay}s...`)
          reconnectTimeout = setTimeout(() => {
            connect().catch((error) => {
              logger?.error('Failed to reconnect', error)
              onError?.(error)
            })
          }, delay)
        }
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger?.error('Failed to connect to Stripe WebSocket', err)
      onError?.(err)

      if (!isClosing) {
        // Retry after delay
        logger?.info('Retrying connection in 10s...')
        reconnectTimeout = setTimeout(() => {
          connect().catch((e) => {
            logger?.error('Failed to reconnect', e)
            onError?.(e instanceof Error ? e : new Error(String(e)))
          })
        }, 10000)
      }
    }
  }

  // Initial connection
  await connect()

  // Return client with close method
  return {
    close: async () => {
      isClosing = true

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }

      if (ws) {
        ws.close()
        ws = null
      }

      logger?.info('WebSocket client closed')
    },
  }
}
