/**
 * Verifies that a `customer.deleted` Stripe event tombstones the row in both
 * the Postgres and Google Sheets destinations.
 *
 * Each suite creates a Stripe customer, lets the engine sync it via WebSocket,
 * deletes it via the Stripe API, and waits for the destination to reflect the
 * deletion. Sheets is skipped when GOOGLE_* env vars are missing.
 */
import pg from 'pg'
import Stripe from 'stripe'
import { google } from 'googleapis'
import { afterAll, beforeAll, expect, it } from 'vitest'
import source from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationSheets, { readSheet } from '@stripe/sync-destination-google-sheets'
import { createEngine } from '@stripe/sync-engine'
import type { ConnectorResolver } from '@stripe/sync-engine'
import type { DestinationOutput } from '@stripe/sync-protocol'
import { drain } from '@stripe/sync-protocol'
import { describeWithEnv } from './test-helpers.js'

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const ts = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, '')
  .slice(0, 15)
const STREAM = 'customers'
const BACKFILL_LIMIT = 5

// MARK: - Helpers

/** Drain a pipeline iterator in the background until it finishes or `stop()` is called. */
function backgroundDrain(iter: AsyncIterator<DestinationOutput>): {
  done: Promise<void>
  stop: () => Promise<void>
} {
  let stopped = false
  const done = (async () => {
    while (!stopped) {
      const { done: iterDone } = await iter.next()
      if (iterDone) return
    }
  })()
  const stop = async () => {
    stopped = true
    await Promise.race([
      iter.return?.(undefined as never) ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 5_000)),
    ])
    await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))])
  }
  return { done, stop }
}

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Mimic the service's `simulate_webhook_sync` endpoint: fetch events from
 * Stripe and pipe them as push-mode input to `pipeline_sync`. The source
 * skips backfill/websocket entirely when `$stdin` is provided.
 */
async function replayStripeEvents(
  engine: Awaited<ReturnType<typeof createEngine>>,
  pipelineFactory: () => Parameters<typeof engine.pipeline_sync>[0],
  stripe: Stripe,
  createdAfter: number
): Promise<void> {
  const events: unknown[] = []
  let startingAfter: string | undefined
  for (;;) {
    const page = await stripe.events.list({
      created: { gt: createdAfter },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    events.push(...page.data)
    if (!page.has_more) break
    startingAfter = page.data.at(-1)!.id
  }
  events.reverse()

  const input = (async function* () {
    for (const e of events) yield e
  })()

  // drain — finite input, finite output
  for await (const msg of engine.pipeline_sync(pipelineFactory(), {}, input)) {
    void msg
  }
}

// MARK: - Postgres

describeWithEnv('stripe customer.deleted → postgres', ['STRIPE_API_KEY'], ({ STRIPE_API_KEY }) => {
  const SCHEMA = `e2e_del_pg_${ts}`
  let pool: pg.Pool
  let stripe: Stripe

  const resolver: ConnectorResolver = {
    resolveSource: async (name) => {
      if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
      return source
    },
    resolveDestination: async (name) => {
      if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
      return destinationPostgres
    },
    sources: () => new Map(),
    destinations: () => new Map(),
  }

  function makePipeline() {
    return {
      source: {
        type: 'stripe',
        stripe: {
          api_key: STRIPE_API_KEY,
          backfill_limit: BACKFILL_LIMIT,
          websocket: true,
        },
      },
      destination: {
        type: 'postgres',
        postgres: { url: POSTGRES_URL, schema: SCHEMA },
      },
      streams: [{ name: STREAM }],
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL })
    await pool.query('SELECT 1')
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    stripe = new Stripe(STRIPE_API_KEY)
    console.log(`\n  Postgres: ${POSTGRES_URL} (schema: ${SCHEMA})`)
  })

  afterAll(async () => {
    if (!pool) return
    if (!process.env.KEEP_TEST_DATA) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    }
    await pool.end()
  })

  it('hard-deletes the row when customer.deleted arrives', async () => {
    const engine = await createEngine(resolver)
    const pipeline = makePipeline()
    await drain(engine.pipeline_setup(pipeline))
    const iter = engine.pipeline_sync(pipeline)[Symbol.asyncIterator]()
    const drainer = backgroundDrain(iter)

    let customerId: string | undefined
    try {
      const customer = await stripe.customers.create({
        name: `e2e-del-pg-${Date.now()}`,
        email: `e2e-del-pg-${Date.now()}@test.local`,
      })
      customerId = customer.id

      console.log(`Waiting for customer ${customerId} to appear in Postgres...`)
      const appeared = await pollUntil(
        async () => {
          const { rows } = await pool.query(`SELECT 1 FROM "${SCHEMA}"."customers" WHERE id = $1`, [
            customerId,
          ])
          return rows.length > 0
        },
        60_000,
        1_000
      )
      expect(appeared, `customer ${customerId} never appeared in postgres`).toBe(true)
      console.log(`Customer ${customerId} appeared in Postgres. Deleting via Stripe API...`)
      await stripe.customers.del(customerId)
      console.log(`Customer ${customerId} deleted in Stripe.`)
      customerId = undefined

      const removed = await pollUntil(
        async () => {
          const { rows } = await pool.query(`SELECT 1 FROM "${SCHEMA}"."customers" WHERE id = $1`, [
            customer.id,
          ])
          return rows.length === 0
        },
        60_000,
        1_000
      )
      expect(removed, `customer ${customer.id} was never tombstoned in postgres`).toBe(true)
      console.log(`    Postgres delete verified: ${customer.id}`)
    } finally {
      await drainer.stop()
      if (customerId) {
        try {
          await stripe.customers.del(customerId)
        } catch {}
      }
    }
  }, 180_000)
})

// MARK: - Google Sheets

describeWithEnv(
  'stripe customer.deleted → google sheets',
  ['STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  ({ STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN }) => {
    let stripe: Stripe
    let sheetsClient: ReturnType<typeof google.sheets>
    let driveClient: ReturnType<typeof google.drive>
    let spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? ''
    let createdSpreadsheetHere = false

    const resolver: ConnectorResolver = {
      resolveSource: async (name) => {
        if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
        return source
      },
      resolveDestination: async (name) => {
        if (name !== 'google_sheets') throw new Error(`Unknown destination: ${name}`)
        return destinationSheets
      },
      sources: () => new Map(),
      destinations: () => new Map(),
    }

    function makePipeline() {
      return {
        source: {
          type: 'stripe',
          stripe: { api_key: STRIPE_API_KEY },
        },
        destination: {
          type: 'google_sheets',
          google_sheets: {
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            ...(spreadsheetId ? { spreadsheet_id: spreadsheetId } : {}),
            spreadsheet_title: `e2e-del-sheets-${ts}`,
            batch_size: 50,
          },
        },
        streams: [{ name: STREAM }],
      }
    }

    beforeAll(async () => {
      stripe = new Stripe(STRIPE_API_KEY)
      const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
      auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
      sheetsClient = google.sheets({ version: 'v4', auth })
      driveClient = google.drive({ version: 'v3', auth })
    })

    afterAll(async () => {
      if (createdSpreadsheetHere && spreadsheetId && !process.env.KEEP_TEST_DATA) {
        try {
          await driveClient.files.delete({ fileId: spreadsheetId })
        } catch {}
      }
    })

    it('removes the row when customer.deleted arrives', async () => {
      const engine = await createEngine(resolver)
      const replayFrom = Math.floor(Date.now() / 1000) - 5

      // If GOOGLE_SPREADSHEET_ID is provided, reuse it; otherwise the destination
      // creates one and emits the new id via destination_config.
      for await (const m of engine.pipeline_setup(makePipeline())) {
        if (
          m.type === 'control' &&
          m.control.control_type === 'destination_config' &&
          typeof m.control.destination_config.spreadsheet_id === 'string' &&
          m.control.destination_config.spreadsheet_id !== spreadsheetId
        ) {
          spreadsheetId = m.control.destination_config.spreadsheet_id
          createdSpreadsheetHere = true
        }
      }
      expect(spreadsheetId, 'no spreadsheet_id available (env or destination)').toBeTruthy()
      console.log(`\n  Sheets: https://docs.google.com/spreadsheets/d/${spreadsheetId}/`)

      let customerId: string | undefined
      try {
        // create customer; replay events through push-mode sync until the row appears
        const customer = await stripe.customers.create({
          name: `e2e-del-sheets-${Date.now()}`,
          email: `e2e-del-sheets-${Date.now()}@test.local`,
        })
        customerId = customer.id
        await new Promise((r) => setTimeout(r, 1500))
        await replayStripeEvents(engine, makePipeline, stripe, replayFrom)

        const rowsAfterCreate = await readSheet(sheetsClient, spreadsheetId, STREAM)
        const idIdx = (rowsAfterCreate[0] ?? []).indexOf('id')
        expect(idIdx, 'id column missing in sheet header').toBeGreaterThanOrEqual(0)
        expect(
          rowsAfterCreate.slice(1).some((row) => row[idIdx] === customer.id),
          `customer ${customer.id} never appeared in sheet`
        ).toBe(true)

        // delete customer; replay again, this time the customer.deleted tombstone removes the row
        await stripe.customers.del(customerId)
        customerId = undefined
        await new Promise((r) => setTimeout(r, 1500))
        await replayStripeEvents(engine, makePipeline, stripe, replayFrom)

        const rowsAfterDelete = await readSheet(sheetsClient, spreadsheetId, STREAM)
        expect(
          rowsAfterDelete.slice(1).some((row) => row[idIdx] === customer.id),
          `customer ${customer.id} was never removed from sheet`
        ).toBe(false)
        console.log(`    Sheets delete verified: ${customer.id}`)
      } finally {
        if (customerId) {
          try {
            await stripe.customers.del(customerId)
          } catch {}
        }
      }
    }, 120_000)
  }
)
