type Env = Record<string, string | undefined>

export function getProxyUrl(env: Env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * Assert that if HTTPS_PROXY/HTTP_PROXY is set, --use-env-proxy is also active.
 * Without it, Node's built-in fetch (undici) silently bypasses the proxy.
 */
export function assertUseEnvProxy(
  env: Env = process.env,
  execArgv: string[] = process.execArgv,
  isBun: boolean = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined'
): void {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl) return

  // Bun always respects proxy env vars natively — no flag needed
  if (isBun) return

  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\s+/)
  const hasFlag = execArgv.includes('--use-env-proxy') || nodeOptions.includes('--use-env-proxy')

  if (!hasFlag) {
    throw new Error(
      `Proxy is configured (${proxyUrl}) but --use-env-proxy is not set.\n` +
        `Node's built-in fetch will bypass the proxy silently.\n` +
        `Fix: add --use-env-proxy to NODE_OPTIONS or pass it to node directly.`
    )
  }
}
