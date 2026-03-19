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
    if (stdin !== undefined) {
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

  describe('arg model: named, positional, stdin', () => {
    it('spec() — no args', async () => {
      const { lines } = await run(['writer', 'spec'])
      expect(lines).toEqual([{ config: {} }])
    })

    it('check() — named only', async () => {
      const { lines } = await run(['writer', 'check', '--config', '{"key":"val"}'])
      expect(lines).toEqual([{ status: 'ok', received: { key: 'val' } }])
    })

    it('positional args only', async () => {
      const { lines } = await run(['counter', 'add', '10'])
      expect(lines).toEqual([52])
    })

    it('stdin only — exported function', async () => {
      const input = ['{"n":1}', '{"n":2}'].join('\n')
      const { lines } = await run(['double'], input)
      expect(lines).toEqual([{ n: 2 }, { n: 4 }])
    })

    it('stdin only — object method', async () => {
      const input = ['{"v":"a"}', '{"v":"b"}'].join('\n')
      const { lines } = await run(['collector', 'collect'], input)
      expect(lines).toEqual([{ collected: ['a', 'b'] }])
    })

    it('named + stdin', async () => {
      const input = ['{"v":"hello"}'].join('\n')
      const { lines } = await run(['writer', 'write', '--config', '{"x":1}'], input)
      expect(lines).toEqual([{ config: { x: 1 }, messages: ['hello'] }])
    })

    it('positional + stdin', async () => {
      const input = ['{"text":"hi"}'].join('\n')
      const { lines } = await run(['transformer', 'apply', 'uppercase'], input)
      expect(lines).toEqual([{ mode: 'uppercase', texts: ['hi'] }])
    })

    it('named + positional + stdin', async () => {
      const input = ['{"text":"hi"}'].join('\n')
      const { lines } = await run(
        ['transformer', 'applyWithOpts', 'upper', '--trim', 'true'],
        input
      )
      expect(lines).toEqual([{ opts: { trim: true }, mode: 'upper', texts: ['hi'] }])
    })

    it('named + empty stdin', async () => {
      // When stdin is piped but empty, the method still receives an async iterable (that yields nothing)
      const { lines } = await run(['writer', 'writeOptional', '--config', '{"x":1}'], '')
      expect(lines).toEqual([{ config: { x: 1 }, messages: [] }])
    })
  })
})
