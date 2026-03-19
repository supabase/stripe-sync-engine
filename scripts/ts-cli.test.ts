// Tests for ts-cli.ts — the generic TypeScript-to-NDJSON CLI bridge.
//
// Runs ts-cli as a subprocess against a test fixture module.
// Run with: npx vitest run scripts/ts-cli.test.ts

import { execFile } from 'child_process'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const CLI = resolve(__dirname, 'ts-cli.ts')
const FIXTURE = resolve(__dirname, 'ts-cli.fixture.ts')

/** Run ts-cli with args, optionally piping stdin. Returns stdout lines parsed as JSON. */
function run(
  args: string[],
  stdin?: string
): Promise<{ lines: unknown[]; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsx', CLI, FIXTURE, ...args],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        const lines = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
        resolve({ lines, stderr, code: error?.code ?? 0 })
      }
    )
    if (stdin) {
      child.stdin?.write(stdin)
      child.stdin?.end()
    }
  })
}

describe('ts-cli', () => {
  describe('producer (object method, no stdin)', () => {
    it('calls a sync method that returns a value', async () => {
      const { lines } = await run(['counter', 'value'])
      expect(lines).toEqual([42])
    })

    it('calls an async method that returns a value', async () => {
      const { lines } = await run(['counter', 'asyncValue'])
      expect(lines).toEqual([99])
    })

    it('calls a method that returns an async iterable', async () => {
      const { lines } = await run(['counter', 'range'])
      expect(lines).toEqual([1, 2, 3])
    })
  })

  describe('pipe (exported function, stdin → stdout)', () => {
    it('transforms stdin NDJSON through an exported function', async () => {
      const input = ['{"n":1}', '{"n":2}', '{"n":3}'].join('\n')
      const { lines } = await run(['double'], input)
      expect(lines).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }])
    })

    it('filters messages (drop some)', async () => {
      const input = ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'].join('\n')
      const { lines } = await run(['onlyEven'], input)
      expect(lines).toEqual([{ n: 2 }, { n: 4 }])
    })
  })

  describe('consumer (object method, stdin → stdout)', () => {
    it('passes stdin to a method and returns yielded output', async () => {
      const input = ['{"v":"a"}', '{"v":"b"}'].join('\n')
      const { lines } = await run(['collector', 'collect'], input)
      expect(lines).toEqual([{ collected: ['a', 'b'] }])
    })
  })

  describe('dot-path property access', () => {
    it('reads a top-level property', async () => {
      const { lines } = await run(['config', 'name'])
      expect(lines).toEqual(['my-sync'])
    })

    it('reads a nested property via dot path', async () => {
      const { lines } = await run(['config', 'source.type'])
      expect(lines).toEqual(['stripe'])
    })

    it('reads a nested object as JSON', async () => {
      const { lines } = await run(['config', 'destination'])
      expect(lines).toEqual([{ type: 'postgres', host: 'localhost' }])
    })
  })

  describe('edge cases', () => {
    it('passes extra CLI args as JSON-parsed arguments', async () => {
      const { lines } = await run(['counter', 'add', '10'])
      expect(lines).toEqual([52]) // 42 + 10
    })

    it('exits with error for missing export', async () => {
      const { code, stderr } = await run(['nonExistent'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('not found')
    })

    it('exits with error for missing method', async () => {
      const { code, stderr } = await run(['counter', 'nonExistent'])
      expect(code).not.toBe(0)
      expect(stderr).toContain('not found')
    })
  })
})
