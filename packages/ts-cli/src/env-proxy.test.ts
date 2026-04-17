import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { assertUseEnvProxy } from './env-proxy.js'

const PROXY_ENV = { HTTPS_PROXY: 'http://proxy.example.test:8080' }

// Inline JS that reimplements assertUseEnvProxy so subprocess tests need no build
const NODE_INLINE_SCRIPT = `
function getProxyUrl(env) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim();
    if (value) return value;
  }
}
function assertUseEnvProxy(env = process.env, execArgv = process.execArgv) {
  const proxyUrl = getProxyUrl(env);
  if (!proxyUrl) return;
  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\\s+/);
  const hasFlag = execArgv.includes('--use-env-proxy') || nodeOptions.includes('--use-env-proxy');
  if (!hasFlag) throw new Error('Proxy is configured (' + proxyUrl + ') but --use-env-proxy is not set.');
}
assertUseEnvProxy();
`

// Bun-native script: imports directly from TS source (run from package root)
const BUN_INLINE_SCRIPT = `
import { assertUseEnvProxy } from './src/env-proxy.ts';
assertUseEnvProxy();
`

const PROXY_ONLY_ENV = {
  ...process.env,
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  NODE_OPTIONS: '',
}

describe('assertUseEnvProxy (unit)', () => {
  it('does not throw when no proxy is configured', () => {
    expect(() => assertUseEnvProxy({}, [])).not.toThrow()
  })

  it('does not throw when proxy is set and --use-env-proxy is in execArgv', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, ['--use-env-proxy'])).not.toThrow()
  })

  it('does not throw when proxy is set and --use-env-proxy is in NODE_OPTIONS', () => {
    expect(() =>
      assertUseEnvProxy({ ...PROXY_ENV, NODE_OPTIONS: '--use-env-proxy' }, [])
    ).not.toThrow()
  })

  it('does not throw when NODE_OPTIONS has multiple flags including --use-env-proxy', () => {
    expect(() =>
      assertUseEnvProxy(
        { ...PROXY_ENV, NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' },
        []
      )
    ).not.toThrow()
  })

  it('throws when proxy is set but --use-env-proxy is absent', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, [], false)).toThrow(/--use-env-proxy/)
  })

  it('does not throw under Bun even without --use-env-proxy (Bun respects proxy natively)', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, [], true)).not.toThrow()
  })

  it('throws when proxy is set via lowercase http_proxy and --use-env-proxy is absent', () => {
    expect(() => assertUseEnvProxy({ http_proxy: 'http://proxy.example.test:8080' }, [])).toThrow(
      /--use-env-proxy/
    )
  })

  it('includes the proxy URL in the error message', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, [])).toThrow('http://proxy.example.test:8080')
  })
})

describe('assertUseEnvProxy (subprocess)', () => {
  it('node: throws when HTTPS_PROXY is set without --use-env-proxy', () => {
    const result = spawnSync('node', ['--input-type=module'], {
      input: NODE_INLINE_SCRIPT,
      env: PROXY_ONLY_ENV,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--use-env-proxy/)
  })

  it('node: does not throw when HTTPS_PROXY is set with --use-env-proxy flag', () => {
    const result = spawnSync('node', ['--use-env-proxy', '--input-type=module'], {
      input: NODE_INLINE_SCRIPT,
      env: PROXY_ONLY_ENV,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
  })

  it('node: does not throw when HTTPS_PROXY is set with --use-env-proxy in NODE_OPTIONS', () => {
    const result = spawnSync('node', ['--input-type=module'], {
      input: NODE_INLINE_SCRIPT,
      env: { ...PROXY_ONLY_ENV, NODE_OPTIONS: '--use-env-proxy' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
  })

  it('bun: does not throw when HTTPS_PROXY is set (bun always respects proxy env)', () => {
    const result = spawnSync('bun', ['run', '--smol', '-'], {
      input: BUN_INLINE_SCRIPT,
      env: PROXY_ONLY_ENV,
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    })
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('bun not found, skipping subprocess test')
      return
    }
    expect(result.status).toBe(0)
  })
})
