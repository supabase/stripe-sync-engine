// Test fixture for ts-cli.test.ts
// Exports various shapes: objects with methods, pipe functions, async iterables.

// ── Object with methods (producer pattern) ──────────────────────

export const counter = {
  value() {
    return 42
  },

  async asyncValue() {
    return 99
  },

  async *range() {
    yield 1
    yield 2
    yield 3
  },

  add(n: number) {
    return 42 + n
  },
}

// ── Pipe functions (stdin → stdout) ─────────────────────────────

/** Double the `n` field of each input object. */
export async function* double(
  messages: AsyncIterableIterator<{ n: number }>
): AsyncIterableIterator<{ n: number }> {
  for await (const msg of messages) {
    yield { n: msg.n * 2 }
  }
}

/** Keep only objects where `n` is even. */
export async function* onlyEven(
  messages: AsyncIterableIterator<{ n: number }>
): AsyncIterableIterator<{ n: number }> {
  for await (const msg of messages) {
    if (msg.n % 2 === 0) yield msg
  }
}

// ── Nested properties (dot-path access) ─────────────────────────

export const config = {
  name: 'my-sync',
  source: {
    type: 'stripe',
    api_key: 'sk_test_123',
  },
  destination: {
    type: 'postgres',
    host: 'localhost',
  },
}

// ── Object with consumer method (stdin → accumulate → yield) ────

export const collector = {
  async *collect(messages: AsyncIterableIterator<{ v: string }>) {
    const values: string[] = []
    for await (const msg of messages) {
      values.push(msg.v)
    }
    yield { collected: values }
  },
}
