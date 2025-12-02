import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { StripeSync } from './stripeSync'
import { runMigrations } from './database/migrate'
import { PgAdapter } from './database/pg-adapter'
import type Stripe from 'stripe'

describe('Webhook Race Condition Tests', () => {
  let stripeSync: StripeSync
  let adapter: PgAdapter
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'
  const stripeApiKey = process.env.STRIPE_API_KEY

  if (!stripeApiKey) {
    console.warn('Skipping webhook concurrent tests - STRIPE_API_KEY not set')
  }

  beforeAll(async () => {
    if (!stripeApiKey) return

    // Run migrations to ensure unique constraint exists
    await runMigrations({ databaseUrl })

    adapter = new PgAdapter({
      max: 20, // Need more connections for concurrent tests
      connectionString: databaseUrl,
      keepAlive: true,
    })

    stripeSync = new StripeSync({
      stripeSecretKey: stripeApiKey,
      stripeApiVersion: '2020-08-27',
      adapter,
    })
  })

  afterAll(async () => {
    if (!stripeSync) return

    // Clean up all test webhooks
    try {
      const webhooks = await stripeSync.listManagedWebhooks()
      const testWebhooks = webhooks.filter((w) => w.url.includes('test-race-'))

      for (const webhook of testWebhooks) {
        try {
          await stripeSync.deleteManagedWebhook(webhook.id)
        } catch (err) {
          console.warn(`Failed to delete test webhook ${webhook.id}:`, err)
        }
      }
    } catch (error) {
      console.warn('Failed to clean up test webhooks:', error)
    }

    // Close database connection
    await adapter.end()
  })

  beforeEach(async () => {
    if (!stripeSync) return

    // Clean up any existing webhooks for this test URL
    const webhooks = await stripeSync.listManagedWebhooks()
    const matchingWebhooks = webhooks.filter((w) => w.url.includes('test-race-'))

    for (const webhook of matchingWebhooks) {
      try {
        await stripeSync.deleteManagedWebhook(webhook.id)
      } catch {
        // Ignore errors, webhook might already be deleted
      }
    }
  })

  describe('findOrCreateManagedWebhook - Concurrent Execution', () => {
    it.skipIf(!stripeApiKey)(
      'should handle 10 concurrent calls without creating duplicates',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-concurrent10.example.com/webhooks`

        // Start 10 parallel calls with same baseUrl
        const promises = Array(10)
          .fill(null)
          .map(() =>
            stripeSync.findOrCreateManagedWebhook(uniqueUrl, {
              enabled_events: ['*'],
              description: 'Test webhook for race condition test',
            })
          )

        const results = await Promise.allSettled(promises)

        // All should succeed
        const succeeded = results.filter((r) => r.status === 'fulfilled')
        expect(succeeded.length).toBe(10)

        // All should return same webhook ID
        const webhookIds = succeeded.map(
          (r) => (r as PromiseFulfilledResult<Stripe.WebhookEndpoint>).value.id
        )
        const uniqueIds = new Set(webhookIds)
        expect(uniqueIds.size).toBe(1)

        // Verify only 1 webhook in database
        const dbWebhooks = await stripeSync.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === uniqueUrl)
        expect(matchingWebhooks.length).toBe(1)

        // Verify only 1 webhook in Stripe
        const stripeWebhooks = await stripeSync['stripe'].webhookEndpoints.list({ limit: 100 })
        const matchingStripeWebhooks = stripeWebhooks.data.filter(
          (w) => w.url === uniqueUrl && w.metadata?.managed_by === 'stripe-sync'
        )
        expect(matchingStripeWebhooks.length).toBe(1)
      },
      30000
    ) // 30 second timeout for this test

    it.skipIf(!stripeApiKey)(
      'should handle concurrent calls with different URLs correctly',
      async () => {
        const timestamp = Date.now()
        const urlA = `https://test-race-${timestamp}-url-a.example.com/webhooks`
        const urlB = `https://test-race-${timestamp}-url-b.example.com/webhooks`

        // 5 calls for URL A, 5 calls for URL B - simultaneously
        const urlAPromises = Array(5)
          .fill(null)
          .map(() =>
            stripeSync.findOrCreateManagedWebhook(urlA, {
              enabled_events: ['*'],
              description: 'Test webhook A',
            })
          )

        const urlBPromises = Array(5)
          .fill(null)
          .map(() =>
            stripeSync.findOrCreateManagedWebhook(urlB, {
              enabled_events: ['*'],
              description: 'Test webhook B',
            })
          )

        const results = await Promise.allSettled([...urlAPromises, ...urlBPromises])

        // All should succeed
        const succeeded = results.filter((r) => r.status === 'fulfilled')
        expect(succeeded.length).toBe(10)

        // Should have exactly 2 different webhook IDs (one for each URL)
        const webhookIds = succeeded.map(
          (r) => (r as PromiseFulfilledResult<Stripe.WebhookEndpoint>).value.id
        )
        const uniqueIds = new Set(webhookIds)
        expect(uniqueIds.size).toBe(2)

        // Verify database state
        const dbWebhooks = await stripeSync.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === urlA || w.url === urlB)
        expect(matchingWebhooks.length).toBe(2)

        // Clean up
        for (const id of uniqueIds) {
          await stripeSync.deleteManagedWebhook(id)
        }
      },
      30000
    )

    it.skipIf(!stripeApiKey)(
      'should reuse existing webhook when called sequentially',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-sequential.example.com/webhooks`

        // First call
        const webhook1 = await stripeSync.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook sequential',
        })

        // Second call - should reuse
        const webhook2 = await stripeSync.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook sequential',
        })

        // Should be the same webhook
        expect(webhook1.id).toBe(webhook2.id)

        // Clean up
        await stripeSync.deleteManagedWebhook(webhook1.id)
      },
      15000
    )
  })

  describe('Unique Constraint Tests', () => {
    it.skipIf(!stripeApiKey)(
      'should handle unique constraint violation gracefully in createManagedWebhook',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-unique-constraint.example.com/webhooks`

        // Create first webhook normally
        const webhook1 = await stripeSync.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook 1',
        })

        // Manually try to create another webhook with same URL directly
        // This should trigger the unique constraint fallback logic
        const webhook2Promise = stripeSync['createManagedWebhook'](uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook 2',
        })

        // The second creation should either:
        // 1. Succeed by detecting the duplicate and returning the existing one
        // 2. Or fail gracefully
        const webhook2 = await webhook2Promise

        // Either way, we should end up with the same webhook
        // (If unique constraint was hit, it returns the existing one)
        expect(webhook2.id).toBeTruthy()

        // Verify only one webhook exists
        const dbWebhooks = await stripeSync.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === uniqueUrl)
        expect(matchingWebhooks.length).toBe(1)

        // Clean up
        await stripeSync.deleteManagedWebhook(webhook1.id)
      },
      15000
    )
  })
})
