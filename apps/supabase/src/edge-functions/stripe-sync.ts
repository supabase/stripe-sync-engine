/**
 * Stripe Sync Edge Function
 *
 *   POST → cron-driven pipeline (source → destination with bounded checkpoints)
 *
 * TODO: Rate limiting — the engine no longer provides distributed rate limiting.
 * source-stripe uses an in-memory token bucket by default (sufficient for single-instance),
 * but if multiple edge function invocations share a Stripe account, a distributed
 * rate limiter backed by the destination Postgres should be added here.
 */

import { createScopedPgStateStore } from '@stripe/sync-state-postgres'
import sourceStripe, {
  type Config as SourceConfig,
  DEFAULT_SYNC_OBJECTS,
} from '@stripe/sync-source-stripe'
import destinationPostgres, { type Config as DestConfig } from '@stripe/sync-destination-postgres'
import pg from 'npm:pg@8'

// ---------------------------------------------------------------------------
// Helpers (inlined — edge functions must be self-contained)
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * Validate worker auth via vault-stored secret.
 * Returns null on success, or an error Response.
 */
async function validateWorkerAuth(
  req: Request,
  pool: pg.Pool,
  secretName = 'stripe_sync_worker_secret'
): Promise<Response | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7)
  const vaultResult = await pool.query(
    `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1`,
    [secretName]
  )

  if (vaultResult.rows.length === 0) {
    return new Response(`Worker secret '${secretName}' not configured in vault`, { status: 500 })
  }
  if (token !== vaultResult.rows[0].decrypted_secret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }

  return null // auth OK
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }

  const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
  const safeSchema = schemaName.replace(/"/g, '""')
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })

  try {
    const authErr = await validateWorkerAuth(req, pool)
    if (authErr) {
      await pool.end()
      return authErr
    }

    // Fast-path: if vault has a skip_until timestamp in the future, bail immediately
    try {
      const { rows: skipRows } = await pool.query(
        `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_skip_until'`
      )
      if (skipRows.length > 0) {
        const skipUntil = Number(skipRows[0].decrypted_secret)
        const remaining = Math.round((skipUntil - Date.now()) / 1000)
        if (skipUntil > Date.now()) {
          console.log(`Skipping — skip_until is ${remaining}s in the future`)
          await pool.end()
          return jsonResponse({
            skipped: true,
            message: `Next sync in ${remaining}s`,
          })
        }
        // skip_until has passed — delete it and continue with sync
        await pool.query(`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`)
      }
    } catch (err) {
      console.warn('Could not read skip_until from vault:', err)
    }

    const stateStore = createScopedPgStateStore(pool, schemaName, 'default')
    let state = (await stateStore.get()) as
      | Record<string, { pageCursor: string | null; status: string }>
      | undefined

    // Debounce: skip if all streams completed within SYNC_INTERVAL
    if (state && Object.values(state).every((s) => s?.status === 'complete')) {
      const { rows } = await pool.query(
        `SELECT MAX(updated_at) as last_update FROM "${safeSchema}"."_sync_state" WHERE sync_id = 'default'`
      )
      const lastUpdate = rows[0]?.last_update
      if (lastUpdate) {
        const elapsed = (Date.now() - new Date(lastUpdate).getTime()) / 1000
        if (elapsed < SYNC_INTERVAL) {
          const skipUntilMs = String(Date.now() + (SYNC_INTERVAL - elapsed) * 1000)
          try {
            await pool.query(`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`)
            await pool.query(`SELECT vault.create_secret($1, 'stripe_sync_skip_until')`, [
              skipUntilMs,
            ])
          } catch (err) {
            console.warn('Could not write skip_until to vault:', err)
          }
          const remainingSec = Math.round(SYNC_INTERVAL - elapsed)
          console.log(
            `Skipping — all streams complete ${Math.round(elapsed)}s ago, next sync in ${remainingSec}s`
          )
          await pool.end()
          return jsonResponse({
            skipped: true,
            message: `All streams complete (${Math.round(elapsed)}s ago)`,
          })
        }
      }
      // Interval elapsed — clear state to start a fresh re-sync
      await pool.query(`DELETE FROM "${safeSchema}"."_sync_state" WHERE sync_id = 'default'`)
      state = undefined
    }

    const sourceConfig: SourceConfig = { api_key: stripeKey }
    const destConfig: DestConfig = {
      connection_string: dbUrl,
      schema: schemaName,
      port: 5432,
      batch_size: 100,
    }

    const defaultSet = new Set(DEFAULT_SYNC_OBJECTS)
    let discoveredStreams: Array<{ name: string; primary_key?: string[][] }> = []
    for await (const msg of sourceStripe.discover({ config: sourceConfig })) {
      if (msg.type === 'catalog') {
        discoveredStreams = msg.catalog.streams
      }
    }
    const catalog = {
      streams: discoveredStreams
        .filter((s) => defaultSet.has(s.name))
        .map((s) => ({
          stream: s,
          sync_mode: 'full_refresh' as const,
          destination_sync_mode: 'append_dedup' as const,
        })),
    }

    // Consume setup generator to run migrations/table creation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _msg of destinationPostgres.setup({ config: destConfig, catalog })) {
      // setup yields control messages; we don't need them here
    }

    let records = 0
    const sourceMessages = sourceStripe.read({ config: sourceConfig, catalog, state })
    const countedSource = (async function* () {
      for await (const msg of sourceMessages) {
        if (msg.type === 'record') records++
        yield msg
      }
    })()
    const destOutput = destinationPostgres.write({ config: destConfig, catalog }, countedSource)

    const MAX_WALL_MS = 30_000
    const startedAt = Date.now()
    let checkpoints = 0
    let stopReason = 'complete'
    for await (const msg of destOutput) {
      if (msg.type === 'state' && msg.state.stream) {
        await stateStore.set(msg.state.stream, msg.state.data)
        checkpoints++
        if (Date.now() - startedAt >= MAX_WALL_MS) {
          stopReason = 'time_limit'
          break
        }
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    await pool.end()
    console.log(
      `Sync pass done — ${records} rows, ${checkpoints} checkpoints, ${elapsed}s elapsed (${stopReason})`
    )

    return jsonResponse({
      status: stopReason === 'complete' ? 'complete' : 'syncing',
      checkpoints,
      records,
      elapsed_s: Number(elapsed),
      stop_reason: stopReason,
    })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Sync error:', error)
    try {
      await pool.end()
    } catch {}
    return jsonResponse({ error: err.message }, 500)
  }
})
