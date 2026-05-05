/**
 * Live reverse ETL e2e script: Postgres -> destination-stripe -> Stripe.
 *
 * What must be running:
 * - A local Postgres database reachable by DATABASE_URL.
 * - Stripe Custom Objects must be enabled for the API key/account.
 * - The Device Custom Object definition named by DEMO_CUSTOM_OBJECT_PLURAL must
 *   exist and define `name`, `device_id`, `device_type`, `city`, and `customer_id`
 *   fields.
 *
 * Example setup:
 *   docker run --rm -d --name reverse-etl-e2e-pg \
 *     -e POSTGRES_PASSWORD=postgres -p 55439:5432 postgres:18
 *
 * Example run:
 *   STRIPE_API_KEY=sk_test_... \
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres \
 *   DEMO_CUSTOM_OBJECT_PLURAL=devices \
 *   pnpm --filter @stripe/sync-e2e exec tsx --conditions bun reverse-etl-e2e.ts
 *
 * The script creates disposable Postgres tables, syncs one row to a regular
 * Stripe Customer and one row to a Stripe Custom Object, verifies both through
 * the Stripe API, and best-effort cleans up the Stripe Customer + Postgres
 * tables. Custom Object deletion is best effort because the v2 API is still
 * evolving.
 */

import pg from 'pg'
import { createEngine } from '../apps/engine/src/lib/engine.ts'
import { createPostgresSource } from '../packages/source-postgres/src/index.ts'
import { createStripeDestination } from '../packages/destination-stripe/src/index.ts'

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55439/postgres'
const stripeApiKey = process.env.STRIPE_API_KEY
const customObjectPluralName = process.env.DEMO_CUSTOM_OBJECT_PLURAL ?? 'devices'
const stripeApiVersion = '2026-03-25.dahlia'
const customObjectApiVersion = 'unsafe-development'
const runId = `reverse_etl_e2e_${Date.now()}`

if (!stripeApiKey) {
  throw new Error('Set STRIPE_API_KEY before running reverse-etl-e2e.ts')
}

function now() {
  return new Date().toISOString()
}

function log(message: string, data?: unknown) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
  console.log(`[${now()}] ${message}${suffix}`)
}

function makeResolver(source: unknown, destination: unknown) {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
    sources: () => new Map(),
    destinations: () => new Map(),
  }
}

async function stripeJson(
  method: string,
  path: string,
  apiVersion: string,
  body?: Record<string, unknown>
) {
  const response = await fetch(new URL(path, 'https://api.stripe.com'), {
    method,
    headers: {
      Authorization: `Bearer ${stripeApiKey}`,
      'Stripe-Version': apiVersion,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(json?.error?.message ?? text)
  }
  return json as Record<string, unknown>
}

function customObjectFieldValue(record: Record<string, unknown>, field: string) {
  const fields = record.fields as Record<string, unknown> | undefined
  const value = fields?.[field] ?? record[field]
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown }).value
  }
  return value
}

async function preparePostgres(client: pg.Client) {
  await client.query(`DROP TABLE IF EXISTS crm_customers`)
  await client.query(`DROP TABLE IF EXISTS devices`)

  await client.query(`
    CREATE TABLE crm_customers (
      id text PRIMARY KEY,
      email text NOT NULL,
      full_name text NOT NULL,
      ignored_internal_note text,
      updated_at timestamptz(3) NOT NULL
    )
  `)
  await client.query(`
    CREATE TABLE devices (
      device_id text PRIMARY KEY,
      name text NOT NULL,
      device_type text,
      city text NOT NULL,
      customer_id text NOT NULL,
      updated_at timestamptz(3) NOT NULL
    )
  `)

  await client.query(
    `INSERT INTO crm_customers
       (id, email, full_name, ignored_internal_note, updated_at)
     VALUES ($1, $2, $3, $4, date_trunc('milliseconds', clock_timestamp()))`,
    [
      'customer_row_1',
      `${runId}@example.com`,
      `Sync Engine Customer ${runId}`,
      'must not be sent to Stripe',
    ]
  )
  await client.query(
    `INSERT INTO devices
       (device_id, name, device_type, city, customer_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, date_trunc('milliseconds', clock_timestamp()))`,
    [`device_${runId}`, `Sync Engine Device ${runId}`, 'reader', 'San Francisco', 'customer_row_1']
  )
}

async function syncStripeCustomer(engine: Awaited<ReturnType<typeof createEngine>>) {
  log('Syncing Postgres table crm_customers -> Stripe Customer')
  const result = await engine.pipeline_sync_batch(
    {
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
    },
    { run_id: `${runId}_customer` }
  )

  const email = `${runId}@example.com`
  const list = await stripeJson(
    'GET',
    `/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
    stripeApiVersion
  )
  const customer = Array.isArray(list.data)
    ? (list.data[0] as Record<string, unknown> | undefined)
    : undefined
  if (!customer || typeof customer.id !== 'string') {
    throw new Error(`Could not find created Stripe Customer for ${email}`)
  }
  if (customer.email !== email || customer.name !== `Sync Engine Customer ${runId}`) {
    throw new Error(
      `Created Stripe Customer fields did not match: email=${String(customer.email)} name=${String(customer.name)}`
    )
  }

  log('Verified Stripe Customer', {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    ending_state: result.ending_state?.source.streams.customer,
  })
  return customer.id
}

async function syncCustomObject(engine: Awaited<ReturnType<typeof createEngine>>) {
  log(`Syncing Postgres table devices -> Custom Object ${customObjectPluralName}`)
  const result = await engine.pipeline_sync_batch(
    {
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
    },
    { run_id: `${runId}_custom_object` }
  )

  const list = await stripeJson(
    'GET',
    `/v2/extend/objects/${customObjectPluralName}?limit=100`,
    customObjectApiVersion
  )
  const records = Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : []
  const object = records.find(
    (record) => customObjectFieldValue(record, 'device_id') === `device_${runId}`
  )
  if (!object || typeof object.id !== 'string') {
    throw new Error(`Could not find created Device Custom Object with device_id device_${runId}`)
  }
  const expectedDeviceFields = {
    name: `Sync Engine Device ${runId}`,
    device_id: `device_${runId}`,
    device_type: 'reader',
    city: 'San Francisco',
    customer_id: 'customer_row_1',
  }
  for (const [field, expected] of Object.entries(expectedDeviceFields)) {
    const actual = customObjectFieldValue(object, field)
    if (actual !== expected) {
      throw new Error(`Created Device Custom Object ${field} did not match: ${String(actual)}`)
    }
  }

  log('Verified Device Custom Object', {
    id: object.id,
    name: customObjectFieldValue(object, 'name'),
    device_id: customObjectFieldValue(object, 'device_id'),
    device_type: customObjectFieldValue(object, 'device_type'),
    city: customObjectFieldValue(object, 'city'),
    customer_id: customObjectFieldValue(object, 'customer_id'),
    ending_state: result.ending_state?.source.streams.devices,
  })
  return object.id
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl })
  let customerId: string | undefined
  let customObjectId: string | undefined

  await client.connect()
  try {
    await preparePostgres(client)

    const source = createPostgresSource()
    const destination = createStripeDestination()
    const engine = await createEngine(makeResolver(source, destination))

    customerId = await syncStripeCustomer(engine)
    customObjectId = await syncCustomObject(engine)

    log('Reverse ETL e2e passed', {
      stripe_customer_id: customerId,
      custom_object_id: customObjectId,
    })
  } finally {
    if (customerId) {
      await stripeJson('DELETE', `/v1/customers/${customerId}`, stripeApiVersion).catch((err) => {
        console.error(
          `Customer cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      log('Deleted Stripe Customer', { id: customerId })
    }
    if (customObjectId) {
      await stripeJson(
        'DELETE',
        `/v2/extend/objects/${customObjectPluralName}/${customObjectId}`,
        customObjectApiVersion
      )
        .then(() => log('Deleted Custom Object', { id: customObjectId }))
        .catch((err) => {
          console.error(
            `Custom Object cleanup failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    }

    await client.query(`DROP TABLE IF EXISTS crm_customers`).catch(() => {})
    await client.query(`DROP TABLE IF EXISTS devices`).catch(() => {})
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
