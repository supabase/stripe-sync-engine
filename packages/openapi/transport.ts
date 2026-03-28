import { ProxyAgent } from 'undici'

export type TransportEnv = Record<string, string | undefined>
type ProxyTarget = URL | string

const proxyAgents = new Map<string, ProxyAgent>()

export function getProxyUrl(env: TransportEnv = process.env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function getNoProxy(env: TransportEnv = process.env): string | undefined {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function parseTargetUrl(target: ProxyTarget): URL | null {
  if (target instanceof URL) {
    return target
  }

  try {
    return new URL(target)
  } catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function parseIpv4(hostname: string): number | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) {
    return null
  }

  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet < 0 || octet > 255) {
      return null
    }
    value = (value << 8) | octet
  }

  return value >>> 0
}

function matchesIpv4Cidr(hostname: string, cidr: string): boolean {
  const [range, prefixText] = cidr.split('/', 2)
  if (!range || !prefixText) {
    return false
  }

  const hostValue = parseIpv4(hostname)
  const rangeValue = parseIpv4(range)
  const prefix = Number(prefixText)
  if (hostValue === null || rangeValue === null || !Number.isInteger(prefix)) {
    return false
  }
  if (prefix < 0 || prefix > 32) {
    return false
  }

  if (prefix === 0) {
    return true
  }

  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (hostValue & mask) === (rangeValue & mask)
}

function matchesNoProxyRule(hostname: string, rawRule: string): boolean {
  const rule = rawRule.trim().toLowerCase()
  if (!rule) {
    return false
  }
  if (rule === '*') {
    return true
  }
  if (rule.includes('/')) {
    return matchesIpv4Cidr(hostname, rule)
  }

  const normalizedRule = rule.startsWith('*.') ? rule.slice(1) : rule
  const exactRule = normalizedRule.startsWith('.') ? normalizedRule.slice(1) : normalizedRule
  if (hostname === exactRule) {
    return true
  }

  const suffixRule = normalizedRule.startsWith('.') ? normalizedRule : `.${normalizedRule}`
  return hostname.endsWith(suffixRule)
}

export function shouldBypassProxy(target: ProxyTarget, env: TransportEnv = process.env): boolean {
  const url = parseTargetUrl(target)
  if (!url) {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  if (!hostname) {
    return false
  }
  if (isLoopbackHost(hostname)) {
    return true
  }

  const noProxy = getNoProxy(env)
  if (!noProxy) {
    return false
  }

  return noProxy.split(',').some((rule) => matchesNoProxyRule(hostname, rule))
}

export function getProxyUrlForTarget(
  target: ProxyTarget,
  env: TransportEnv = process.env
): string | undefined {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl || shouldBypassProxy(target, env)) {
    return undefined
  }
  return proxyUrl
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
  const proxyUrl = getProxyUrlForTarget(input, env)
  if (!proxyUrl) {
    return fetch(input, init)
  }

  return fetch(input, {
    ...init,
    dispatcher: getProxyAgent(proxyUrl),
  } as ProxyAwareRequestInit)
}
