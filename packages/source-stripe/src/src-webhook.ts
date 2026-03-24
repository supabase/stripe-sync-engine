import type { ConfiguredCatalog, Message } from '@tx-stripe/protocol'
import http from 'node:http'
import type Stripe from 'stripe'
import type { Config, WebhookInput } from './index'
import type { ResourceConfig } from './types'
import { processStripeEvent } from './process-event'

// MARK: - processWebhookInput

/**
 * Verify a raw webhook body+signature and delegate to processStripeEvent.
 * Use this at the HTTP transport boundary. For already-verified Stripe.Event
 * objects (WebSocket, events API), call processStripeEvent directly.
 */
export async function* processWebhookInput(
  input: WebhookInput,
  config: Config,
  stripe: Stripe,
  catalog: ConfiguredCatalog,
  registry: Record<string, ResourceConfig>,
  streamNames: Set<string>
): AsyncGenerator<Message> {
  if (!config.webhook_secret) {
    throw new Error('webhook_secret is required for raw webhook signature verification')
  }
  const signature = (input.headers['stripe-signature'] as string) ?? ''
  const event = await stripe.webhooks.constructEvent(input.body, signature, config.webhook_secret)
  yield* processStripeEvent(event, config, stripe, catalog, registry, streamNames)
}

// MARK: - LiveInput queue

/** An item in the live input queue. HTTP webhooks include resolve/reject for backpressure. */
export type LiveInput = {
  data: WebhookInput | Stripe.Event
  resolve?: () => void
  reject?: (err: Error) => void
}

/** Create a push/wait/drain queue for live webhook events. */
export function createInputQueue() {
  let inputWaiter: ((input: LiveInput) => void) | null = null
  const queue: LiveInput[] = []

  function push(input: LiveInput) {
    if (inputWaiter) {
      const waiter = inputWaiter
      inputWaiter = null
      waiter(input)
    } else {
      queue.push(input)
    }
  }

  function wait(): Promise<LiveInput> {
    return new Promise<LiveInput>((resolve) => {
      inputWaiter = resolve
    })
  }

  async function* drain(
    config: Config,
    stripe: Stripe,
    catalog: ConfiguredCatalog,
    registry: Record<string, ResourceConfig>,
    streamNames: Set<string>
  ): AsyncGenerator<Message> {
    while (queue.length > 0) {
      const queued = queue.shift()!
      yield* processStripeEvent(
        queued.data as Stripe.Event,
        config,
        stripe,
        catalog,
        registry,
        streamNames
      )
    }
  }

  return { push, wait, drain, queue }
}

// MARK: - Webhook HTTP server

export function startWebhookServer(port: number, push: (input: LiveInput) => void): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (!req.headers['stripe-signature']) {
        res.writeHead(400).end('Missing stripe-signature')
        return
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      push({
        data: { body, headers: req.headers as Record<string, string | string[] | undefined> },
        resolve,
        reject,
      })
      promise
        .then(() => res.writeHead(200).end('{"received":true}'))
        .catch((err) => res.writeHead(500).end(err instanceof Error ? err.message : String(err)))
    })
  })
  server.listen(port)
  return server
}
