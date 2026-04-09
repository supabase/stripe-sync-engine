import {
  StripeAccountSchema,
  StripeWebhookEndpointSchema,
  StripeApiListSchema,
  StripeApiRequestError,
  type StripeAccount,
  type StripeApiList,
  type StripeWebhookEndpoint,
} from '@stripe/sync-openapi'
import { withHttpRetry } from './retry.js'
import { stripeEventSchema, type StripeEvent } from './spec.js'
import { fetchWithProxy, parsePositiveInteger, type TransportEnv } from './transport.js'

export type StripeClientConfig = {
  api_key: string
  api_version: string
  base_url?: string
}

export { getProxyUrl as getStripeProxyUrl } from './transport.js'

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'

export { StripeApiRequestError as StripeRequestError }

export type StripeClient = ReturnType<typeof makeClient>

export function makeClient(config: StripeClientConfig, env: TransportEnv = process.env) {
  const baseUrl = (config.base_url ?? DEFAULT_STRIPE_API_BASE).replace(/\/$/, '')
  const timeoutMs = parsePositiveInteger(
    'STRIPE_REQUEST_TIMEOUT_MS',
    env.STRIPE_REQUEST_TIMEOUT_MS,
    10_000
  )
  const logRequests = env.STRIPE_LOG_REQUESTS === '1'

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': config.api_version,
  }

  async function request(
    method: string,
    path: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const url = new URL(path, baseUrl)

    let body: string | undefined
    if (method === 'GET' && params) {
      appendSearchParams(url.searchParams, params)
    } else if (params) {
      body = encodeFormData(params)
    }

    if (logRequests) {
      console.error({
        msg: 'Stripe API request started',
        method,
        path,
        apiVersion: config.api_version,
      })
    }

    const start = Date.now()
    const response = await fetchWithProxy(
      url.toString(),
      {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      },
      env
    )

    const json = (await response.json()) as unknown

    if (logRequests) {
      console.error({
        msg: 'Stripe API request completed',
        method,
        path,
        status: response.status,
        elapsed: Date.now() - start,
        requestId: response.headers.get('request-id'),
        apiVersion: config.api_version,
      })
    }

    if (!response.ok) {
      throw new StripeApiRequestError(response.status, json, method, path)
    }

    return json
  }

  /**
   * Wraps `request` with retry logic for GET requests only.
   * Non-GET methods (POST, DELETE) pass through without retry to avoid
   * duplicating side effects.
   */
  async function requestWithRetry(
    method: string,
    path: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    if (method === 'GET') {
      return withHttpRetry(() => request(method, path, params))
    }
    return request(method, path, params)
  }

  return {
    async getAccount(): Promise<StripeAccount> {
      const json = await requestWithRetry('GET', '/v1/account')
      return StripeAccountSchema.parse(json)
    },

    async listEvents(params: {
      created?: { gt: number }
      limit?: number
      starting_after?: string
    }): Promise<StripeApiList<StripeEvent>> {
      const query: Record<string, unknown> = {}
      if (params.limit) query.limit = params.limit
      if (params.starting_after) query.starting_after = params.starting_after
      if (params.created?.gt) query['created[gt]'] = params.created.gt
      const json = await requestWithRetry('GET', '/v1/events', query)
      return StripeApiListSchema(stripeEventSchema).parse(json)
    },

    async listWebhookEndpoints(params?: {
      limit?: number
    }): Promise<StripeApiList<StripeWebhookEndpoint>> {
      const json = await requestWithRetry('GET', '/v1/webhook_endpoints', params)
      return StripeApiListSchema(StripeWebhookEndpointSchema).parse(json)
    },

    async createWebhookEndpoint(params: {
      url: string
      enabled_events: string[]
      metadata?: Record<string, string>
    }): Promise<StripeWebhookEndpoint> {
      const json = await requestWithRetry('POST', '/v1/webhook_endpoints', params)
      return StripeWebhookEndpointSchema.parse(json)
    },

    async deleteWebhookEndpoint(id: string): Promise<void> {
      await requestWithRetry('DELETE', `/v1/webhook_endpoints/${encodeURIComponent(id)}`)
    },
  }
}

// MARK: - URL encoding helpers

function appendSearchParams(sp: URLSearchParams, params: Record<string, unknown>) {
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      sp.set(key, String(value))
    }
  }
}

function encodeFormData(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key
    if (value == null) continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeFormData(value as Record<string, unknown>, fullKey))
    } else if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(`${fullKey}[]`)}=${encodeURIComponent(String(item))}`)
      }
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}
