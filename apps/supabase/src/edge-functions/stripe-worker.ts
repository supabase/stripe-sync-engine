/**
 * Stripe Sync Coordinator
 *
 * Triggered by pg_cron at a configurable interval.
 * Discovers streams via source-stripe resource registry,
 * creates sync state in Postgres, and fans out to
 * stripe-backfill-worker for parallel per-stream backfill.
 */

import Stripe from 'npm:stripe'
import pg from 'npm:pg@8'
import { buildResourceRegistry, catalogFromRegistry } from '@stripe/sync-source-stripe'

// Module-level singletons (reused across requests in Deno edge functions)
const dbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!dbUrl) {
  throw new Error('SUPABASE_DB_URL secret not configured')
}

const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7 // Once a week default
const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
const safeSchema = schemaName.replace(/"/g, '""')

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
const registry = buildResourceRegistry(stripe)

Deno.serve(async (req) => {
  // Auth: validate Bearer token against vault worker secret
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7)
  const vaultResult = await pool.query(
    `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_worker_secret'`
  )
  if (vaultResult.rows.length === 0) {
    return new Response('Worker secret not configured in vault', { status: 500 })
  }
  if (token !== vaultResult.rows[0].decrypted_secret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }

  // Create state tables (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${safeSchema}"._sync_runs (
      sync_id      text PRIMARY KEY,
      status       text NOT NULL DEFAULT 'syncing',
      total_streams int NOT NULL,
      started_at   timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS "${safeSchema}"._sync_state (
      sync_id    text NOT NULL,
      stream     text NOT NULL,
      cursor     text,
      status     text NOT NULL DEFAULT 'pending',
      records    int  NOT NULL DEFAULT 0,
      error      text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sync_id, stream)
    );
  `)

  // Check for recent completed run within SYNC_INTERVAL → skip if too soon
  const recentRun = await pool.query(
    `SELECT sync_id, completed_at FROM "${safeSchema}"._sync_runs
     WHERE status = 'complete'
       AND completed_at > now() - make_interval(secs => $1)
     ORDER BY completed_at DESC LIMIT 1`,
    [SYNC_INTERVAL]
  )
  if (recentRun.rows.length > 0) {
    const msg = `Skipping — completed run ${recentRun.rows[0].sync_id} at ${recentRun.rows[0].completed_at} (within ${SYNC_INTERVAL}s window)`
    console.log(msg)
    return new Response(JSON.stringify({ skipped: true, message: msg }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Build catalog to discover streams
  const catalog = catalogFromRegistry(registry)
  const streams = catalog.streams.map((s) => s.name)

  // Generate sync ID
  const syncId = `sync_${Date.now()}`

  // Insert run + per-stream state rows
  await pool.query(
    `INSERT INTO "${safeSchema}"._sync_runs (sync_id, total_streams) VALUES ($1, $2)`,
    [syncId, streams.length]
  )
  for (const stream of streams) {
    await pool.query(
      `INSERT INTO "${safeSchema}"._sync_state (sync_id, stream) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [syncId, stream]
    )
  }

  // Fan out: one worker per stream
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const workerUrl = `${supabaseUrl}/functions/v1/stripe-backfill-worker`

  await Promise.all(
    streams.map((stream) =>
      fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({ sync_id: syncId, stream }),
      })
    )
  )

  console.log(`Started sync ${syncId} with ${streams.length} streams`)

  return new Response(
    JSON.stringify({ sync_id: syncId, streams: streams.length, status: 'started' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
