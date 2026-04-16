import type { ConfiguredCatalog, Message } from '@stripe/sync-protocol'
import http from 'node:http'
import type { StripeEvent } from './spec.js'
import type { Config, WebhookInput } from './index.js'
import type { ResourceConfig } from './types.js'
import { processStripeEvent } from './process-event.js'
import { verifyWebhookSignature } from './webhookVerify.js'

// MARK: - processWebhookInput

/**
 * Verify a raw webhook body+signature and delegate to processStripeEvent.
 * Use this at the HTTP transport boundary. For already-verified StripeEvent
 * objects (WebSocket, events API), call processStripeEvent directly.
 */
export async function* processWebhookInput(
  input: WebhookInput,
  config: Config,
  catalog: ConfiguredCatalog,
  registry: Record<string, ResourceConfig>,
  streamNames: Set<string>,
  accountId?: string
): AsyncGenerator<Message> {
  if (!config.webhook_secret) {
    throw new Error('webhook_secret is required for raw webhook signature verification')
  }
  const signature = (input.headers['stripe-signature'] as string) ?? ''
  const event = verifyWebhookSignature(input.body, signature, config.webhook_secret)
  yield* processStripeEvent(event, config, catalog, registry, streamNames, accountId)
}

// MARK: - LiveInput queue

/** An item in the live input queue. HTTP webhooks include resolve/reject for backpressure. */
export type LiveInput = {
  data: WebhookInput | StripeEvent
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

  function wait(signal?: AbortSignal): Promise<LiveInput> {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!)
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    return new Promise<LiveInput>((resolve, reject) => {
      const waiter = (input: LiveInput) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(input)
      }

      const onAbort = () => {
        if (inputWaiter === waiter) {
          inputWaiter = null
        }
        reject(signal!.reason)
      }

      inputWaiter = waiter
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function* drain(
    config: Config,
    catalog: ConfiguredCatalog,
    registry: Record<string, ResourceConfig>,
    streamNames: Set<string>,
    accountId?: string
  ): AsyncGenerator<Message> {
    while (queue.length > 0) {
      const queued = queue.shift()!
      yield* processStripeEvent(
        queued.data as StripeEvent,
        config,
        catalog,
        registry,
        streamNames,
        accountId
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
