/**
 * Minimal sync: pipe fake records into destination-postgres2.
 *
 * Usage:
 *   docker compose up -d postgres
 *   npx tsx packages/destination-postgres2/example.ts
 */
import destination, { type Config } from './src/index.ts'
import type { CatalogMessage, DestinationInput } from '@stripe/sync-protocol'

const config: Config = {
  connectionString:
    process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:54320/postgres',
  schema: 'public',
}

const catalog: CatalogMessage = {
  type: 'catalog',
  streams: [
    { name: 'customers', primary_key: [['id']] },
    { name: 'invoices', primary_key: [['id']] },
  ],
}

// Simulate a source emitting records + state checkpoints
async function* fakeSource(): AsyncIterableIterator<DestinationInput> {
  yield {
    type: 'record',
    stream: 'customers',
    data: { id: 'cus_1', name: 'Alice', email: 'alice@example.com' },
    emitted_at: Date.now(),
  }
  yield {
    type: 'record',
    stream: 'customers',
    data: { id: 'cus_2', name: 'Bob', email: 'bob@example.com' },
    emitted_at: Date.now(),
  }
  yield { type: 'state', stream: 'customers', data: { after: 'cus_2' } }
  yield {
    type: 'record',
    stream: 'invoices',
    data: { id: 'inv_1', customer: 'cus_1', amount: 9900 },
    emitted_at: Date.now(),
  }
  yield {
    type: 'record',
    stream: 'invoices',
    data: { id: 'inv_2', customer: 'cus_2', amount: 4200 },
    emitted_at: Date.now(),
  }
  yield { type: 'state', stream: 'invoices', data: { after: 'inv_2' } }
  // Re-emit cus_1 to exercise upsert (name changed)
  yield {
    type: 'record',
    stream: 'customers',
    data: { id: 'cus_1', name: 'Alice Smith', email: 'alice@example.com' },
    emitted_at: Date.now(),
  }
  yield { type: 'state', stream: 'customers', data: { after: 'cus_1', phase: 'update' } }
}

// -- check --
console.log('--- check ---')
const checkResult = await destination.check(config)
console.log(checkResult)

// -- write --
console.log('\n--- write ---')
const output = destination.write(config, catalog, fakeSource())
for await (const msg of output) {
  console.log(msg)
}

console.log('\n--- done ---')
