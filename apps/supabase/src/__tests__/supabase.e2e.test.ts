/**
 * Supabase E2E Tests
 *
 * Tests the consolidated stripe-sync edge function against a real Supabase project.
 *
 * Required env vars:
 *   SUPABASE_PROJECT_ID
 *   SUPABASE_PERSONAL_ACCESS_TOKEN
 *   STRIPE_API_KEY
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { SupabaseSetupClient } from '../supabase.js'
import { describeWithEnv } from '../../../../e2e/test-helpers.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describeWithEnv(
  'Supabase E2E',
  ['SUPABASE_PROJECT_ID', 'SUPABASE_PERSONAL_ACCESS_TOKEN', 'STRIPE_API_KEY'],
  ({ SUPABASE_PROJECT_ID, SUPABASE_PERSONAL_ACCESS_TOKEN, STRIPE_API_KEY }) => {
    let client: SupabaseSetupClient
    let stripe: Stripe

    beforeAll(async () => {
      client = new SupabaseSetupClient({
        accessToken: SUPABASE_PERSONAL_ACCESS_TOKEN,
        projectRef: SUPABASE_PROJECT_ID,
      })
      stripe = new Stripe(STRIPE_API_KEY)

      // Ensure clean slate
      try {
        const installed = await client.isInstalled()
        if (installed) {
          await client.uninstall()
          await sleep(5000)
        }
      } catch {
        try {
          await client.uninstall()
        } catch {}
        await sleep(5000)
      }
    })

    afterAll(async () => {
      // Always attempt uninstall
      try {
        await client.uninstall()
      } catch {}
    })

    describe('webhook flow', () => {
      let customerId: string | undefined

      afterAll(async () => {
        // Clean up test customer
        if (customerId) {
          try {
            await stripe.customers.del(customerId)
          } catch {}
        }
      })

      it('should install without initial sync', async () => {
        await client.install(
          STRIPE_API_KEY,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true // skipInitialSync
        )

        const installed = await client.isInstalled()
        expect(installed).toBe(true)
      })

      it('should have empty data tables after install', async () => {
        const result = (await client.runSQL(`SELECT count(*) as count FROM stripe.customers`)) as {
          count: number
        }[]
        expect(Number(result[0].count)).toBe(0)
      })

      it('should receive customer.created webhook', async () => {
        const testName = `Supabase E2E ${Date.now()}`
        const customer = await stripe.customers.create({
          name: testName,
          email: 'supabase-e2e@test.local',
        })
        customerId = customer.id

        // Poll until webhook delivers the data (up to 90s)
        let found = false
        for (let i = 0; i < 18; i++) {
          await sleep(5000)
          const result = (await client.runSQL(
            `SELECT id, name FROM stripe.customers WHERE id = '${customer.id}'`
          )) as { id: string; name: string }[]
          if (result.length > 0) {
            expect(result[0].id).toBe(customer.id)
            expect(result[0].name).toBe(testName)
            found = true
            break
          }
        }
        expect(found).toBe(true)
      })

      it('should receive customer.updated webhook', async () => {
        expect(customerId).toBeDefined()

        const updatedName = `Updated Supabase E2E ${Date.now()}`
        await stripe.customers.update(customerId!, { name: updatedName })

        // Poll until the update arrives (up to 60s)
        let found = false
        for (let i = 0; i < 12; i++) {
          await sleep(5000)
          const result = (await client.runSQL(
            `SELECT name FROM stripe.customers WHERE id = '${customerId}'`
          )) as { name: string }[]
          if (result[0]?.name === updatedName) {
            found = true
            break
          }
        }
        expect(found).toBe(true)
      })

      it('should uninstall cleanly', async () => {
        await client.uninstall()
        const installed = await client.isInstalled()
        expect(installed).toBe(false)
      })
    })

    describe('backfill with self-reinvocation', () => {
      it('should install and sync data via backfill', async () => {
        await client.install(STRIPE_API_KEY)

        // Poll until we see data landing (up to 120s)
        // The backfill workers self-reinvoke for continuous progress
        let totalRecords = 0
        for (let i = 0; i < 12; i++) {
          await sleep(10000)

          // Check _sync_runs table for progress
          try {
            const runs = (await client.runSQL(
              `SELECT sync_id, status, total_streams FROM stripe._sync_runs ORDER BY started_at DESC LIMIT 1`
            )) as { sync_id: string; status: string; total_streams: number }[]

            if (runs.length > 0) {
              const run = runs[0]

              // Count total records across all streams
              const states = (await client.runSQL(
                `SELECT SUM(records) as total FROM stripe._sync_state WHERE sync_id = '${run.sync_id}'`
              )) as { total: string }[]

              totalRecords = Number(states[0]?.total || 0)
              console.log(`  backfill progress: ${totalRecords} records (${run.status})`)

              if (totalRecords > 100) break
            }
          } catch {
            // _sync_runs may not exist yet
          }
        }

        expect(totalRecords).toBeGreaterThan(100)

        // Verify at least one data table has rows
        const counts: Record<string, number> = {}
        for (const table of ['product', 'customer', 'coupon', 'price']) {
          try {
            const result = (await client.runSQL(
              `SELECT count(*) as count FROM stripe.${table}`
            )) as { count: number }[]
            counts[table] = Number(result[0].count)
          } catch {}
        }
        console.log('  table counts:', counts)

        const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
        expect(totalRows).toBeGreaterThan(0)
      })

      it('should uninstall cleanly after backfill', async () => {
        await client.uninstall()
        const installed = await client.isInstalled()
        expect(installed).toBe(false)
      })
    })
  }
)
