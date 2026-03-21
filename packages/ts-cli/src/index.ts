// ts-cli — Turn any TypeScript module into a NDJSON CLI
//
// Generic bridge: takes any exported object/function and exposes its
// methods via stdin/stdout NDJSON. Not specific to sync engine — works
// with any TypeScript module.
//
// Usage:
//   npx tsx ts-cli.ts <module> <method> [--key value ...]
//
// If the module has a default export, <export> can be omitted:
//   npx tsx ts-cli.ts ./mod spec
//   npx tsx ts-cli.ts ./mod check --config '{"key":"val"}'
//   npx tsx ts-cli.ts ./mod read --config '...' --catalog '...'
//   ... | npx tsx ts-cli.ts ./mod write --config '...' --catalog '...'
//
// Calling convention:
//   fn(...[named if non-empty], ...positional, ...[stdin if piped])
//
// Named params (--key value) are collected into a single object. Positional
// args (no -- prefix) are passed as separate arguments. If stdin is piped,
// it's appended as the last argument (as an async iterator of parsed NDJSON).
//
// If the return value is async-iterable, each yielded value is written as
// NDJSON to stdout.

import { resolve } from 'node:path'
import { createInterface } from 'readline'

// ── NDJSON helpers ──────────────────────────────────────────────

/** Read NDJSON lines from stdin as an async iterator. */
async function* readStdin<T = unknown>(): AsyncIterableIterator<T> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as T
  }
}

/** Write a value as one NDJSON line to stdout. */
function writeLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

/** Write each value from an async iterable as NDJSON to stdout. */
async function writeAll(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const value of iter) {
    writeLine(value)
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value
}

function parseArg(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/**
 * Parse CLI args into named flags and positional values.
 * Named: `--key value` pairs collected into an object (null if none).
 * Positional: non-flag args, JSON-parsed where possible.
 */
function parseArgs(rawArgs: string[]): {
  named: Record<string, unknown> | null
  positional: unknown[]
} {
  const named: Record<string, unknown> = {}
  const positional: unknown[] = []
  let hasNamed = false

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!
    if (arg.startsWith('--')) {
      hasNamed = true
      const key = arg.slice(2)
      const value = rawArgs[++i]
      named[key] = value === undefined ? true : parseArg(value)
    } else {
      positional.push(parseArg(arg))
    }
  }

  return { named: hasNamed ? named : null, positional }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const [modulePath, ...rest] = process.argv.slice(2)

  if (!modulePath) {
    console.error('Usage: ts-cli.ts <module> [export] [method] [...args]')
    console.error('')
    console.error('If the module has a default export, <export> can be omitted:')
    console.error('  ts-cli.ts ./mod read \'{"key":"val"}\'    # mod.default.read(...)')
    console.error('  ts-cli.ts ./mod myObj read              # mod.myObj.read(...)')
    console.error('  ts-cli.ts ./mod spec                    # mod.default.spec()')
    console.error('  ... | ts-cli.ts ./mod write             # pipe stdin → mod.default.write(...)')
    console.error('')
    process.exit(1)
  }

  // Resolve relative paths against cwd, not this script's location
  const resolved = modulePath.startsWith('.') ? resolve(process.cwd(), modulePath) : modulePath
  const mod = await import(resolved)

  // Resolve export name: if rest[0] matches a named export, use it.
  // Otherwise, use "default" and treat rest[0] as the method name.
  let exportName: string
  let methodName: string | undefined
  let rawArgs: string[]

  const hasDefault = 'default' in mod
  const defaultTarget = hasDefault ? mod['default'] : undefined
  // rest[0] is a method/property on the default export?
  const firstIsMethodOnDefault =
    hasDefault &&
    rest.length > 0 &&
    defaultTarget != null &&
    typeof defaultTarget === 'object' &&
    rest[0] in defaultTarget

  if (rest.length === 0) {
    // ts-cli ./mod  →  use default, no method
    exportName = 'default'
    methodName = undefined
    rawArgs = []
  } else if (firstIsMethodOnDefault) {
    // ts-cli ./mod read '...'  →  default export, rest[0] is method
    exportName = 'default'
    ;[methodName, ...rawArgs] = rest
  } else if (rest[0] === 'default' || (rest[0] in mod && !hasDefault)) {
    // ts-cli ./mod default read  →  explicit export name
    // ts-cli ./mod namedExport read  →  named export (only when no default)
    ;[exportName, methodName, ...rawArgs] = rest
  } else if (hasDefault) {
    // ts-cli ./mod someArg  →  default export, rest[0] is method
    exportName = 'default'
    ;[methodName, ...rawArgs] = rest
  } else {
    // No default, treat rest[0] as export name
    ;[exportName, methodName, ...rawArgs] = rest
  }

  const target = mod[exportName]

  if (target === undefined) {
    console.error(`Export "${exportName}" not found in ${modulePath}`)
    console.error(`Available exports: ${Object.keys(mod).join(', ')}`)
    process.exit(1)
  }

  // Case 1: target is a function (transform or factory)
  if (typeof target === 'function' && !methodName) {
    const hasPipedInput = !process.stdin.isTTY
    const { named, positional } = parseArgs(rawArgs)

    const callArgs: unknown[] = []
    if (named) callArgs.push(named)
    callArgs.push(...positional)
    if (hasPipedInput) callArgs.push(readStdin())

    const result = target(...callArgs)
    if (isAsyncIterable(result)) {
      await writeAll(result)
    } else {
      const value = await result
      if (value !== undefined) writeLine(value)
    }
    process.exit(0)
  }

  // Case 2: target is an object, methodName is a dot-path to a property or method
  if (typeof target === 'object' && methodName) {
    // Resolve dot path: "sync.source" → target.sync.source
    const parts = methodName.split('.')
    let current: any = target
    let parent: any = target
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        console.error(`Cannot access "${part}" on ${typeof current}`)
        process.exit(1)
      }
      parent = current
      current = current[part]
    }

    if (current === undefined) {
      console.error(`"${methodName}" not found on "${exportName}"`)
      console.error(`Available keys: ${Object.keys(parent).join(', ')}`)
      process.exit(1)
    }

    // If it resolved to a function, call it
    if (typeof current === 'function') {
      const hasPipedInput = !process.stdin.isTTY
      const { named, positional } = parseArgs(rawArgs)

      const callArgs: unknown[] = []
      if (named) callArgs.push(named)
      callArgs.push(...positional)
      if (hasPipedInput) callArgs.push(readStdin())

      const result = current.call(parent, ...callArgs)
      if (isAsyncIterable(result)) {
        await writeAll(result)
      } else {
        const value = await result
        if (value !== undefined) writeLine(value)
      }
    } else {
      // It's a property — output its value as JSON
      writeLine(current)
    }

    process.exit(0)
  }

  console.error(`Don't know how to invoke "${exportName}"${methodName ? `.${methodName}` : ''}`)
  process.exit(1)
}

main()
