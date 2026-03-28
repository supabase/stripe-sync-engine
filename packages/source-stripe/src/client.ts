import Stripe from 'stripe'
import {
  getHttpsProxyAgentForTarget,
  parsePositiveInteger,
  type TransportEnv,
} from './transport.js'

export type StripeClientConfigInput = {
  api_key: string
  base_url?: string
}
export { getProxyUrl as getStripeProxyUrl } from './transport.js'

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'

function buildBaseUrlOptions(
  baseUrl: string
): Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'> {
  const url = new URL(baseUrl)
  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
    protocol: url.protocol.replace(':', '') as Stripe.HttpProtocol,
  }
}

export function buildStripeClientOptions(
  config: StripeClientConfigInput,
  env: TransportEnv = process.env
): Stripe.StripeConfig {
  const options: Stripe.StripeConfig = {
    timeout: parsePositiveInteger(
      'STRIPE_REQUEST_TIMEOUT_MS',
      env.STRIPE_REQUEST_TIMEOUT_MS,
      10_000
    ),
  }

  if (config.base_url) {
    const httpAgent = getHttpsProxyAgentForTarget(config.base_url, env)
    return {
      ...options,
      ...buildBaseUrlOptions(config.base_url),
      ...(httpAgent ? { httpAgent } : {}),
    }
  }

  const httpAgent = getHttpsProxyAgentForTarget(DEFAULT_STRIPE_API_BASE, env)
  if (httpAgent) {
    options.httpAgent = httpAgent
  }

  return options
}

function attachStripeRequestLogging(stripe: Stripe, env: TransportEnv = process.env): void {
  if (env.STRIPE_LOG_REQUESTS !== '1') {
    return
  }

  stripe.on('request', (event) => {
    console.info({
      msg: 'Stripe API request started',
      method: event.method,
      path: event.path,
      apiVersion: event.api_version,
      requestStartTime: event.request_start_time,
    })
  })

  stripe.on('response', (event) => {
    console.info({
      msg: 'Stripe API request completed',
      method: event.method,
      path: event.path,
      status: event.status,
      elapsed: event.elapsed,
      requestId: event.request_id,
      apiVersion: event.api_version,
    })
  })
}

export function makeClient(
  config: StripeClientConfigInput,
  env: TransportEnv = process.env
): Stripe {
  const stripe = new Stripe(config.api_key, buildStripeClientOptions(config, env))
  attachStripeRequestLogging(stripe, env)
  return stripe
}
