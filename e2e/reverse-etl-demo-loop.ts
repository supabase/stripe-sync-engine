/**
 * Live reverse ETL demo loop: Postgres -> Sync Engine -> Stripe.
 *
 * This is intentionally demo-focused, not assertion-focused. It creates the
 * demo tables if needed, then polls both pipelines every 2 seconds:
 *
 * - `crm_customers` -> Stripe Customer
 * - `devices` -> Stripe Device Custom Object
 *
 * The loop persists Sync Engine state to `.tmp/reverse-etl-demo-state.json`.
 * That state is the cursor. Do not use a stable `run_id` for this loop:
 * `run_id` is for bounded backfills, while this demo should continuously pick
 * up rows inserted after the script starts.
 *
 * What must exist:
 * - Stripe Custom Objects enabled for the API key/account.
 * - A Device Custom Object definition at `/v2/extend/objects/devices` with
 *   `name`, `device_id`, `device_type`, `city`, and `customer_id` fields.
 *
 * Terminal 1: start Postgres
 *   docker rm -f reverse-etl-demo-pg 2>/dev/null || true
 *   docker run --rm -d --name reverse-etl-demo-pg \
 *     -e POSTGRES_PASSWORD=postgres -p 55439:5432 postgres:18
 *
 * Terminal 2: run the demo loop with an in-process Sync Engine
 *   STRIPE_API_KEY=sk_test_... \
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres \
 *   DEMO_CUSTOM_OBJECT_PLURAL=devices \
 *   pnpm --filter @stripe/sync-e2e exec tsx --conditions bun reverse-etl-demo-loop.ts
 *
 * Optional Terminal 2/3: run through a real Sync Engine HTTP server instead
 *   PORT=4010 pnpm --filter @stripe/sync-engine dev
 *
 *   STRIPE_API_KEY=sk_test_... \
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres \
 *   ENGINE_URL=http://127.0.0.1:4010 \
 *   DEMO_CUSTOM_OBJECT_PLURAL=devices \
 *   pnpm --filter @stripe/sync-e2e exec tsx --conditions bun reverse-etl-demo-loop.ts
 *
 * Terminal 3: insert a Customer row
 *   psql "$DATABASE_URL" -c "
 *     INSERT INTO crm_customers (id, email, full_name)
 *     VALUES (
 *       'customer_' || floor(extract(epoch from clock_timestamp()) * 1000)::text,
 *       'demo+' || floor(extract(epoch from clock_timestamp()) * 1000)::text || '@example.com',
 *       'Demo Customer'
 *     );
 *   "
 *
 * Terminal 3: insert a Device row
 *   psql "$DATABASE_URL" -c "
 *     INSERT INTO devices (name, device_id, device_type, city, customer_id)
 *     VALUES (
 *       'Demo Reader',
 *       'device_' || floor(extract(epoch from clock_timestamp()) * 1000)::text,
 *       'reader',
 *       'San Francisco',
 *       'customer_demo'
 *     );
 *   "
 *
 * Dashboard:
 * - Customers: https://dashboard.stripe.com/test/customers
 * - Devices:   https://dashboard.stripe.com/test/custom-objects/devices
 *
 * Useful reset while practicing:
 *   rm -f .tmp/reverse-etl-demo-state.json
 *   psql "$DATABASE_URL" -c "TRUNCATE crm_customers; DROP TABLE IF EXISTS devices;"
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { EofPayload, PipelineConfig, SyncState } from '@stripe/sync-protocol'
import type { ConnectorResolver } from '../apps/engine/src/lib/index.ts'
import { createEngine } from '../apps/engine/src/lib/engine.ts'
import { createPostgresSource } from '../packages/source-postgres/src/index.ts'
import { createStripeDestination } from '../packages/destination-stripe/src/index.ts'

type DemoState = {
  customer?: SyncState
  device?: SyncState
}

type PipelineRunner = (
  pipeline: PipelineConfig,
  state: SyncState | undefined
) => Promise<EofPayload>

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55439/postgres'
const stripeApiKey = process.env.STRIPE_API_KEY
const engineUrl = process.env.ENGINE_URL
const customObjectPluralName = process.env.DEMO_CUSTOM_OBJECT_PLURAL ?? 'devices'
const stripeApiVersion = process.env.STRIPE_API_VERSION ?? '2026-03-25.dahlia'
const customObjectApiVersion = 'unsafe-development'
const pollMs = process.env.POLL_MS ? Number.parseInt(process.env.POLL_MS, 10) : 2_000
const defaultStateFile = fileURLToPath(
  new URL('../.tmp/reverse-etl-demo-state.json', import.meta.url)
)
const stateFile = process.env.DEMO_STATE_FILE
  ? resolve(process.env.DEMO_STATE_FILE)
  : defaultStateFile

if (!stripeApiKey) {
  throw new Error('Set STRIPE_API_KEY before running reverse-etl-demo-loop.ts')
}

function now() {
  return new Date().toISOString()
}

function log(message: string, data?: unknown) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
  console.log(`[${now()}] ${message}${suffix}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeResolver(
  source: ReturnType<typeof createPostgresSource>,
  destination: ReturnType<typeof createStripeDestination>
): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
    sources: () => new Map(),
    destinations: () => new Map(),
  }
}

async function preparePostgres() {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_customers (
        id text PRIMARY KEY,
        email text NOT NULL,
        full_name text NOT NULL,
        ignored_internal_note text,
        updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id text NOT NULL,
        name text NOT NULL,
        device_type text,
        city text NOT NULL,
        customer_id text NOT NULL,
        updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        PRIMARY KEY (device_id)
      )
    `)

    log('Demo tables are ready', { tables: ['crm_customers', 'devices'] })
  } finally {
    await client.end()
  }
}

function customerPipeline(): PipelineConfig {
  return {
    source: {
      type: 'postgres',
      postgres: {
        url: databaseUrl,
        table: 'crm_customers',
        stream: 'customer',
        primary_key: ['id'],
        cursor_field: 'updated_at',
        page_size: 100,
      },
    },
    destination: {
      type: 'stripe',
      stripe: {
        api_key: stripeApiKey,
        api_version: stripeApiVersion,
        object: 'standard_object',
        write_mode: 'create',
        streams: {
          customer: {
            field_mapping: {
              email: 'email',
              name: 'full_name',
            },
          },
        },
      },
    },
    streams: [{ name: 'customer', sync_mode: 'incremental' }],
  }
}

function devicePipeline(): PipelineConfig {
  return {
    source: {
      type: 'postgres',
      postgres: {
        url: databaseUrl,
        table: 'devices',
        stream: 'devices',
        primary_key: ['device_id'],
        cursor_field: 'updated_at',
        page_size: 100,
      },
    },
    destination: {
      type: 'stripe',
      stripe: {
        api_key: stripeApiKey,
        api_version: customObjectApiVersion,
        object: 'custom_object',
        write_mode: 'create',
        streams: {
          devices: {
            plural_name: customObjectPluralName,
            field_mapping: {
              name: 'name',
              device_id: 'device_id',
              device_type: 'device_type',
              city: 'city',
              customer_id: 'customer_id',
            },
          },
        },
      },
    },
    streams: [{ name: 'devices', sync_mode: 'incremental' }],
  }
}

async function createRunner(): Promise<PipelineRunner> {
  if (engineUrl) {
    const baseUrl = engineUrl.endsWith('/') ? engineUrl : `${engineUrl}/`
    log('Using remote Sync Engine', { engine_url: engineUrl })
    return async (pipeline, state) => {
      const response = await fetch(new URL('pipeline_sync_batch', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipeline, state }),
      })
      const text = await response.text()
      const json = text ? JSON.parse(text) : {}
      if (!response.ok) {
        throw new Error(`Remote Sync Engine returned ${response.status}: ${JSON.stringify(json)}`)
      }
      return json as EofPayload
    }
  }

  log('Using in-process Sync Engine')
  const source = createPostgresSource()
  const destination = createStripeDestination()
  const engine = await createEngine(makeResolver(source, destination))
  return (pipeline, state) => engine.pipeline_sync_batch(pipeline, { state })
}

async function loadState(): Promise<DemoState> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as DemoState
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {}
    throw err
  }
}

async function saveState(state: DemoState) {
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n')
}

function streamSummary(result: EofPayload, stream: string) {
  return {
    status: result.status,
    has_more: result.has_more,
    request_records: result.request_progress.streams[stream]?.record_count ?? 0,
    total_records: result.run_progress.streams[stream]?.record_count ?? 0,
    cursor: result.ending_state?.source.streams[stream],
  }
}

async function main() {
  await preparePostgres()
  const runner = await createRunner()
  const pipelines = {
    customer: customerPipeline(),
    device: devicePipeline(),
  }
  let state = await loadState()

  log('Reverse ETL demo loop started', {
    poll_ms: pollMs,
    state_file: stateFile,
    custom_object_plural_name: customObjectPluralName,
  })
  log('Insert rows in another terminal, then watch the Stripe Dashboard.')

  while (true) {
    try {
      const customerResult = await runner(pipelines.customer, state.customer)
      state = { ...state, customer: customerResult.ending_state }
      log('Customer poll complete', streamSummary(customerResult, 'customer'))

      const deviceResult = await runner(pipelines.device, state.device)
      state = { ...state, device: deviceResult.ending_state }
      log('Device poll complete', streamSummary(deviceResult, 'devices'))

      await saveState(state)
    } catch (err) {
      console.error(`[${now()}] Demo poll failed`, err instanceof Error ? err.stack : err)
    }

    await sleep(pollMs)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
