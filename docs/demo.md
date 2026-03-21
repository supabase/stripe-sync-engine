---
theme: default
title: Sync Protocol — Live Demo
transition: slide-left
mdc: true
---

# Source & Destination

The simplest connectors that satisfy the sync protocol

---

## The Source

A source is an **async generator** — it `yield`s messages.

```ts {monaco}
// Source: reads from an upstream system, emits Messages
const source = {
  async *read(params) {
    const items = [
      { id: '1', name: 'Widget A', price: 100 },
      { id: '2', name: 'Widget B', price: 200 },
    ]

    for (const data of items) {
      // RecordMessage: one row for one stream
      yield { type: 'record', stream: 'products', data, emitted_at: Date.now() }
    }

    // StateMessage: opaque cursor — only this source reads/writes it
    yield { type: 'state', stream: 'products', data: { last_id: '2' } }
  }
}
```

No base class. No registration. No framework.

---

## The Destination

A destination **consumes** messages and `yield`s state checkpoints back.

```ts {monaco}
// Destination: writes to a downstream system, yields StateMessages back
const destination = {
  async *write(params, $stdin) {
    const store = {}

    for await (const msg of $stdin) {
      if (msg.type === 'record') {
        // upsert by primary key
        store[msg.data.id] = msg.data
        console.log(`  → upsert ${msg.stream}[${msg.data.id}]:`, msg.data)
      }

      if (msg.type === 'state') {
        // write committed — pass the checkpoint back to the orchestrator
        yield msg
      }
    }
  }
}
```

The destination never sees logs, errors, or status messages — the engine filters them.

---

## Wire Them Together

The engine is a `for await` loop. Edit anything and hit run:

```ts {monaco-run} {autorun:false}
const source = {
  async *read(params) {
    const items = [
      { id: '1', name: 'Widget A', price: 100 },
      { id: '2', name: 'Widget B', price: 200 },
    ]
    for (const data of items) {
      yield { type: 'record', stream: 'products', data, emitted_at: Date.now() }
    }
    yield { type: 'state', stream: 'products', data: { last_id: '2' } }
  }
}

const destination = {
  async *write(params, $stdin) {
    for await (const msg of $stdin) {
      if (msg.type === 'record') {
        console.log(`  → upsert ${msg.stream}[${msg.data.id}]: "${msg.data.name}"`)
      }
      if (msg.type === 'state') {
        console.log(`  ✓ checkpoint:`, msg.data)
        yield msg
      }
    }
  }
}

// The engine: pipe source.read() into destination.write()
const params = { config: {}, catalog: {}, state: {} }

console.log('sync started')
for await (const state of destination.write(params, source.read(params))) {
  console.log('  state saved:', JSON.stringify(state.data))
}
console.log('sync complete')
```
