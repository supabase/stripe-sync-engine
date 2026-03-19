// ts-cli — Turn any TypeScript module into a NDJSON CLI
//
// Generic bridge: takes any exported object/function and exposes its
// methods via stdin/stdout NDJSON. Not specific to sync engine — works
// with any TypeScript module.
//
// Usage:
//   npx tsx ts-cli.ts <module> <export> [method] [...args]
//
// Patterns:
//   Producer (no stdin → stdout):  npx tsx ts-cli.ts ./mod myObj read
//   Pipe     (stdin → stdout):     npx tsx ts-cli.ts ./mod myTransform
//   Consumer (stdin → stdout):     echo '...' | npx tsx ts-cli.ts ./mod myObj write
//
// Auto-detects the pattern: if stdin is piped, passes it as the first
// argument (as an async iterator of parsed NDJSON lines). If the return
// value is async-iterable, each yielded value is written as NDJSON to stdout.

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

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const [modulePath, exportName, methodName, ...rawArgs] = process.argv.slice(2)

  if (!modulePath || !exportName) {
    console.error('Usage: npx tsx ts-cli.ts <module> <export> [path] [...args]')
    console.error('')
    console.error('Examples:')
    console.error('  npx tsx ts-cli.ts ./mod myObj value        # call myObj.value(), write result')
    console.error('  npx tsx ts-cli.ts ./mod myObj range        # yield from myObj.range()')
    console.error('  npx tsx ts-cli.ts ./mod myObj config.src   # read myObj.config.src property')
    console.error('  ... | npx tsx ts-cli.ts ./mod myTransform  # pipe stdin through function')
    console.error('')
    process.exit(1)
  }

  // Resolve relative paths against cwd, not this script's location
  const resolved = modulePath.startsWith('.') ? resolve(process.cwd(), modulePath) : modulePath
  const mod = await import(resolved)
  const target = mod[exportName]

  if (target === undefined) {
    console.error(`Export "${exportName}" not found in ${modulePath}`)
    console.error(`Available exports: ${Object.keys(mod).join(', ')}`)
    process.exit(1)
  }

  const args = rawArgs.map(parseArg)

  // Case 1: target is a function (transform or factory)
  if (typeof target === 'function' && !methodName) {
    // It's a pipe: stdin → transform → stdout
    const stdin = readStdin()
    const result = target(stdin, ...args)
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
      const hasPipedInput = !process.stdin.isTTY && args.length === 0
      const callArgs = hasPipedInput ? [readStdin(), ...args] : args
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
