/**
 * Stripe Sync Worker
 *
 * Triggered by pg_cron at a configurable interval (default: 60 seconds).
 *
 * Uses v2 packages directly:
 * - @stripe/source-stripe for StripeSyncWorker + resource registry
 * - stateful-sync for PostgresStateManager (task management)
 * - @stripe/destination-postgres for PostgresDestinationWriter (upserts)
 */

import Stripe from 'npm:stripe'
import pg from 'npm:pg@8'
import {
  StripeSyncWorker,
  buildResourceRegistry,
  CORE_SYNC_OBJECTS,
  type WorkerTaskManager,
} from '@stripe/source-stripe'
import { PostgresStateManager } from 'stateful-sync'
import { PostgresDestinationWriter } from '@stripe/destination-postgres'
import { fromRecordMessage, type RecordMessage } from '@stripe/sync-protocol'

// Reuse these between requests (Deno edge functions reuse module-level state)
const dbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!dbUrl) {
  throw new Error('SUPABASE_DB_URL secret not configured')
}
const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7 // Once a week default
const rateLimit = Number(Deno.env.get('RATE_LIMIT')) || 60
const workerCount = Number(Deno.env.get('WORKER_COUNT')) || 10
const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const accountId = Deno.env.get('STRIPE_ACCOUNT_ID')!

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
const registry = buildResourceRegistry(stripe)
const stateManager = new PostgresStateManager(pool, {
  schema: schemaName,
  syncSchema: syncTablesSchemaName,
})
const writer = new PostgresDestinationWriter({
  schema: schemaName,
  poolConfig: { connectionString: dbUrl },
})

const tableNames = CORE_SYNC_OBJECTS.map((obj: keyof typeof registry) => registry[obj].tableName)

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7) // Remove 'Bearer '

  // Validate that the token matches the unique worker secret stored in vault
  const vaultResult = await pool.query(
    `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_worker_secret'`
  )

  if (vaultResult.rows.length === 0) {
    return new Response('Worker secret not configured in vault', { status: 500 })
  }
  const storedSecret = vaultResult.rows[0].decrypted_secret
  if (token !== storedSecret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }

  const runKey = await stateManager.reconciliationRun(
    accountId,
    'edge-worker',
    tableNames,
    SYNC_INTERVAL
  )
  if (runKey === null) {
    const activeSkipResult = await pool.query(
      `SELECT decrypted_secret::timestamptz::text AS skip_until
       FROM vault.decrypted_secrets
       WHERE name = 'stripe_sync_skip_until'
         AND decrypted_secret::timestamptz >= NOW()
       LIMIT 1`
    )

    let skipUntil = activeSkipResult.rows[0]?.skip_until
    if (!skipUntil) {
      skipUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await pool.query(`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`)
      await pool.query(`SELECT vault.create_secret($1, 'stripe_sync_skip_until')`, [skipUntil])
    }
    const completedRun = await stateManager.getCompletedRun(accountId, SYNC_INTERVAL)
    const message = `Skipping resync — a successful run completed at ${completedRun?.runStartedAt.toISOString()} (within ${SYNC_INTERVAL}s window). Cron paused until ${skipUntil}.`
    console.log(message)
    return new Response(JSON.stringify({ skipped: true, message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  await stateManager.resetStuckRunningObjects(runKey.accountId, runKey.runStartedAt, 1)

  const taskManager: WorkerTaskManager = {
    claimNextTask: (aid, rst, rl) => stateManager.claimNextTask(aid, rst, rl),
    updateSyncObject: (aid, rst, obj, gte, lte, updates) =>
      stateManager.updateSyncObject(aid, rst, obj, gte, lte, updates),
    releaseObjectSync: (aid, rst, obj, pc, gte, lte) =>
      stateManager.releaseObjectSync(aid, rst, obj, pc, gte, lte),
  }

  const workers = Array.from(
    { length: workerCount },
    () =>
      new StripeSyncWorker(
        stripe,
        {},
        taskManager,
        accountId,
        registry,
        runKey,
        async (messages: RecordMessage[], _accountId: string) => {
          // Group by stream (table name) and upsert
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const byStream = new Map<string, { [Key: string]: any }[]>()
          for (const msg of messages) {
            const items = byStream.get(msg.stream) ?? []
            items.push(fromRecordMessage(msg))
            byStream.set(msg.stream, items)
          }
          for (const [table, items] of byStream) {
            await writer.upsertMany(items, table)
          }
        },
        Infinity,
        rateLimit
      )
  )
  const MAX_EXECUTION_MS = 20_000 // stop before edge function limit
  workers.forEach((worker) => worker.start())
  await Promise.race([
    Promise.all(workers.map((w) => w.waitUntilDone())),
    new Promise((resolve) => setTimeout(resolve, MAX_EXECUTION_MS)),
  ])
  workers.forEach((w) => w.shutdown())
  const totals = await stateManager.getObjectSyncedCounts(accountId, runKey.runStartedAt)
  const totalSynced = (Object.values(totals) as number[]).reduce(
    (sum: number, n: number) => sum + n,
    0
  )
  console.log(`Finished: ${totalSynced} objects synced`, totals)

  return new Response(JSON.stringify({ totals }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
