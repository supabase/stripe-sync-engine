/**
 * Stripe Sync Worker
 *
 * Triggered by pg_cron at a configurable interval (default: 60 seconds). Uses pgmq for durable work queue.
 *
 * Flow:
 * 1. Read batch of messages from pgmq (qty=10, vt=60s)
 * 2. If queue empty: enqueue all objects (continuous sync)
 * 3. Process messages in parallel (Promise.all):
 *    - processNext(object)
 *    - Delete message on success
 *    - Re-enqueue if hasMore
 * 4. Return results summary
 *
 * Concurrency:
 * - Multiple workers can run concurrently via overlapping pg_cron triggers.
 * - Each worker processes its batch of messages in parallel (Promise.all).
 * - pgmq visibility timeout prevents duplicate message reads across workers.
 * - processNext() is idempotent (uses internal cursor tracking), so duplicate
 *   processing on timeout/crash is safe.
 */

import { StripeSync } from '../../index'
import postgres from 'postgres'

const QUEUE_NAME = 'stripe_sync_work'
const VISIBILITY_TIMEOUT = 60 // seconds
const BATCH_SIZE = 10

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7) // Remove 'Bearer '

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), { status: 500 })
  }

  let sql
  let stripeSync

  try {
    sql = postgres(dbUrl, { max: 1, prepare: false })
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to create postgres connection',
        details: error.message,
        stack: error.stack,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Validate that the token matches the unique worker secret stored in vault
    const vaultResult = await sql`
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'stripe_sync_worker_secret'
    `

    if (vaultResult.length === 0) {
      await sql.end()
      return new Response('Worker secret not configured in vault', { status: 500 })
    }

    const storedSecret = vaultResult[0].decrypted_secret
    if (token !== storedSecret) {
      await sql.end()
      return new Response('Forbidden: Invalid worker secret', { status: 403 })
    }

    stripeSync = new StripeSync({
      poolConfig: { connectionString: dbUrl, max: 1 },
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
      enableSigma: (Deno.env.get('ENABLE_SIGMA') ?? 'false') === 'true',
    })
  } catch (error) {
    await sql.end()
    return new Response(
      JSON.stringify({
        error: 'Failed to create StripeSync',
        details: error.message,
        stack: error.stack,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Read batch of messages from queue
    const messages = await sql`
      SELECT * FROM pgmq.read(${QUEUE_NAME}::text, ${VISIBILITY_TIMEOUT}::int, ${BATCH_SIZE}::int)
    `

    // If queue empty, enqueue all objects for continuous sync
    if (messages.length === 0) {
      // Create sync run to make enqueued work visible (status='pending')
      const { objects } = await stripeSync.joinOrCreateSyncRun('worker')
      const msgs = objects.map((object) => JSON.stringify({ object }))

      await sql`
        SELECT pgmq.send_batch(
          ${QUEUE_NAME}::text,
          ${sql.array(msgs)}::jsonb[]
        )
      `

      return new Response(JSON.stringify({ enqueued: objects.length, objects }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Process messages in parallel
    const results = await Promise.all(
      messages.map(async (msg) => {
        const { object } = msg.message as { object: string }

        try {
          const result = await stripeSync.processNext(object)

          // Delete message on success (cast to bigint to disambiguate overloaded function)
          await sql`SELECT pgmq.delete(${QUEUE_NAME}::text, ${msg.msg_id}::bigint)`

          // Re-enqueue if more pages
          if (result.hasMore) {
            await sql`SELECT pgmq.send(${QUEUE_NAME}::text, ${sql.json({ object })}::jsonb)`
          }

          return { object, ...result }
        } catch (error) {
          // Log error but continue to next message
          // Message will become visible again after visibility timeout
          console.error(`Error processing ${object}:`, error)
          return {
            object,
            processed: 0,
            hasMore: false,
            error: error.message,
            stack: error.stack,
          }
        }
      })
    )

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Worker error:', error)
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  } finally {
    if (sql) await sql.end()
    if (stripeSync) await stripeSync.postgresClient.pool.end()
  }
})
