import { HttpsProxyAgent } from 'https-proxy-agent'
import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

export type TransportEnv = Record<string, string | undefined>
type ProxyTarget = URL | string

const httpsProxyAgents = new Map<string, InstanceType<typeof HttpsProxyAgent>>()

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

function getHttpsProxyAgent(proxyUrl: string): InstanceType<typeof HttpsProxyAgent> {
  let agent = httpsProxyAgents.get(proxyUrl)
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl)
    httpsProxyAgents.set(proxyUrl, agent)
  }
  return agent
}

export function getHttpsProxyAgentForTarget(
  target: ProxyTarget,
  env: TransportEnv = process.env
): InstanceType<typeof HttpsProxyAgent> | undefined {
  const proxyUrl = getProxyUrlForTarget(target, env)
  return proxyUrl ? getHttpsProxyAgent(proxyUrl) : undefined
}

const DANGEROUSLY_VERBOSE_LOGGING = process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true'

/** Wraps fetch with curl-style trace logging when DANGEROUSLY_VERBOSE_LOGGING=true. */
export function tracedFetch(input: URL | string, init: RequestInit = {}): Promise<Response> {
  if (!DANGEROUSLY_VERBOSE_LOGGING || !logger.isLevelEnabled('trace')) {
    return fetch(input, init)
  }

  const method = (init.method ?? 'GET').toUpperCase()
  const url = String(input)
  const reqId = crypto.randomUUID().slice(0, 8)
  const start = Date.now()

  const headerPairs: [string, string][] = []
  if (init.headers) {
    new Headers(init.headers as HeadersInit).forEach((v, k) => {
      headerPairs.push([k, v])
    })
  }

  const curlParts = [`curl -X ${method}`]
  for (const [k, v] of headerPairs) {
    curlParts.push(`-H '${k}: ${v}'`)
  }
  if (init.body != null) {
    curlParts.push(`-d '${String(init.body).replaceAll("'", "'\\''")}'`)
  }
  curlParts.push(`'${url}'`)
  const curl = curlParts.join(' \\\n  ')

  logger.trace(`[http ${reqId}] → ${method} ${url}\n${curl}`)

  return fetch(input, init).then((res) => {
    const resClone = res.clone()
    logger.trace(`[http ${reqId}] ← ${res.status} ${method} ${url} (${Date.now() - start}ms)`)
    resClone
      .text()
      .then((body) => {
        logger.trace(`[http ${reqId}] ← body: ${body.slice(0, 4096)}`)
      })
      .catch(() => {})
    return res
  })
}
