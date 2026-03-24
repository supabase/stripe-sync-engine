/**
 * Stripe Backfill Worker
 *
 * Processes a single stream (e.g. "customers", "invoices") for a given sync run.
 * Paginates a bounded number of pages per invocation, saves cursor to Postgres,
 * and self-reinvokes if there are more pages. When done, runs a barrier query
 * to detect if all streams have completed.
 */

import Stripe from 'npm:stripe'
import pg from 'npm:pg@8'
import { buildResourceRegistry } from '@stripe/source-stripe'
import { upsertMany } from '@stripe/destination-postgres'

// Module-level singletons (reused across requests in Deno edge functions)
const dbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!dbUrl) {
  throw new Error('SUPABASE_DB_URL secret not configured')
}

const PAGES_PER_INVOCATION = Number(Deno.env.get('PAGES_PER_INVOCATION')) || 10
const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
const safeSchema = schemaName.replace(/"/g, '""')

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
const registry = buildResourceRegistry(stripe)

/** Find the resource config whose tableName matches the given stream name. */
function findConfigByTableName(stream: string) {
  const entry = Object.values(registry).find((cfg) => cfg.tableName === stream)
  if (!entry) throw new Error(`Unknown stream: ${stream}`)
  return entry
}

/**
 * Barrier-based completion check.
 * Atomically marks the sync run as complete if all streams have settled
 * (status = 'complete' or 'error'). Uses UPDATE ... WHERE NOT EXISTS
 * so exactly one worker wins the race.
 */
async function checkCompletion(syncId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE "${safeSchema}"._sync_runs
     SET status = 'complete', completed_at = now()
     WHERE sync_id = $1
       AND status = 'syncing'
       AND NOT EXISTS (
         SELECT 1 FROM "${safeSchema}"._sync_state
         WHERE sync_id = $1 AND status NOT IN ('complete', 'error')
       )
     RETURNING *`,
    [syncId]
  )

  if (result.rowCount && result.rowCount > 0) {
    console.log(`Sync ${syncId} complete — all streams settled`)
  }
}

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

  // Parse request body
  const { sync_id: syncId, stream } = (await req.json()) as {
    sync_id: string
    stream: string
  }
  if (!syncId || !stream) {
    return new Response('Missing sync_id or stream', { status: 400 })
  }

  try {
    // Load cursor from state table
    const stateResult = await pool.query(
      `SELECT cursor, records FROM "${safeSchema}"._sync_state
       WHERE sync_id = $1 AND stream = $2`,
      [syncId, stream]
    )
    if (stateResult.rows.length === 0) {
      throw new Error(`No state row for sync_id=${syncId} stream=${stream}`)
    }

    const existingCursor = stateResult.rows[0].cursor as string | null
    const existingRecords = stateResult.rows[0].records as number

    // Mark as syncing
    await pool.query(
      `UPDATE "${safeSchema}"._sync_state
       SET status = 'syncing', updated_at = now()
       WHERE sync_id = $1 AND stream = $2`,
      [syncId, stream]
    )

    // Resolve list function for this stream
    const config = findConfigByTableName(stream)
    const listFn = config.listFn

    // Paginate bounded number of pages
    let cursor = existingCursor
    let hasMore = true
    let newRecords = 0

    for (let page = 0; page < PAGES_PER_INVOCATION && hasMore; page++) {
      const params: Stripe.PaginationParams = { limit: 100 }
      if (cursor) params.starting_after = cursor

      const response = await listFn(params)

      if (response.data.length > 0) {
        // Upsert records into destination table
        await upsertMany(pool, schemaName, stream, response.data as Record<string, unknown>[])
        newRecords += response.data.length
        // Update cursor to last item's ID
        const lastItem = response.data.at(-1) as { id?: string }
        if (lastItem?.id) {
          cursor = lastItem.id
        }
      }

      hasMore = response.has_more
    }

    // Save cursor + record count
    await pool.query(
      `UPDATE "${safeSchema}"._sync_state
       SET cursor = $1, status = $2, records = $3, updated_at = now()
       WHERE sync_id = $4 AND stream = $5`,
      [cursor, hasMore ? 'syncing' : 'complete', existingRecords + newRecords, syncId, stream]
    )

    if (hasMore) {
      // More pages — self-reinvoke (fire-and-forget)
      const supabaseUrl = Deno.env.get('SUPABASE_URL')
      const workerUrl = `${supabaseUrl}/functions/v1/stripe-backfill-worker`
      fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({ sync_id: syncId, stream }),
      }).catch((err) => console.error(`Self-reinvoke failed for ${stream}:`, err))

      console.log(
        `Stream ${stream}: synced ${newRecords} records (${existingRecords + newRecords} total), continuing...`
      )
    } else {
      // Stream complete — check if ALL streams are done
      await checkCompletion(syncId)
      console.log(`Stream ${stream}: complete — ${existingRecords + newRecords} total records`)
    }

    return new Response(
      JSON.stringify({
        sync_id: syncId,
        stream,
        records: existingRecords + newRecords,
        has_more: hasMore,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`Worker error for stream ${stream}:`, errorMessage)

    // Mark stream as error
    await pool
      .query(
        `UPDATE "${safeSchema}"._sync_state
         SET status = 'error', error = $1, updated_at = now()
         WHERE sync_id = $2 AND stream = $3`,
        [errorMessage, syncId, stream]
      )
      .catch((e) => console.error('Failed to update error state:', e))

    // Still check completion — other streams may be done
    await checkCompletion(syncId).catch((e) => console.error('Completion check failed:', e))

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
