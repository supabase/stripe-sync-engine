import { ProxyAgent } from 'undici'

export type TransportEnv = Record<string, string | undefined>

const proxyAgents = new Map<string, ProxyAgent>()

export function parsePositiveInteger(
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

export function getProxyUrl(env: TransportEnv = process.env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(proxyUrl)
    proxyAgents.set(proxyUrl, agent)
  }
  return agent
}

type ProxyAwareRequestInit = RequestInit & { dispatcher?: ProxyAgent }

export function withFetchProxy(
  init: RequestInit = {},
  env: TransportEnv = process.env
): ProxyAwareRequestInit {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl) {
    return init
  }

  return {
    ...init,
    dispatcher: getProxyAgent(proxyUrl),
  }
}

export function fetchWithProxy(
  input: URL | string,
  init: RequestInit = {},
  env: TransportEnv = process.env
): Promise<Response> {
  return fetch(input, withFetchProxy(init, env))
}
