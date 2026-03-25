/**
 * Consolidated Stripe Sync Edge Function
 *
 * Single Deno.serve() with path-based routing:
 *
 *   POST   /setup     → install (run migrations, create webhook, store secrets)
 *   GET    /setup     → status (installation status + sync runs)
 *   DELETE /setup     → uninstall (drop schema, delete webhooks/secrets/functions)
 *   POST   /webhook   → process Stripe webhook event
 *   POST   /sync      → cron coordinator (discovers streams, fans out to /backfill)
 *   POST   /backfill  → per-stream backfill worker
 */

import { runMigrationsFromContent, migrations } from '@stripe/sync-state-postgres'
import sourceStripe, {
  type Config as SourceConfig,
  buildResourceRegistry,
  catalogFromRegistry,
} from '@stripe/sync-source-stripe'
import destinationPostgres, {
  type Config as DestConfig,
  upsertMany,
} from '@stripe/sync-destination-postgres'
import Stripe from 'npm:stripe'
import pg from 'npm:pg@8'

// ---------------------------------------------------------------------------
// Shared env + helpers (run once per cold start)
// ---------------------------------------------------------------------------

// Inlined from schemaComment.ts — edge functions must be self-contained (no relative imports)
type SchemaInstallationStatus =
  | 'installing'
  | 'installed'
  | 'install error'
  | 'uninstalling'
  | 'uninstalled'
  | 'uninstall error'

interface StripeSchemaComment {
  status: SchemaInstallationStatus
  oldVersion?: string
  newVersion?: string
  errorMessage?: string
  startTime?: number
}

function parseSchemaComment(comment: string | null | undefined): StripeSchemaComment {
  if (!comment) return { status: 'uninstalled' }
  try {
    const parsed = JSON.parse(comment) as StripeSchemaComment
    if (parsed.status) return parsed
  } catch {
    // fall through to legacy parsing
  }
  if (!comment.includes('stripe-sync')) return { status: 'uninstalled' }
  const versionMatch = comment.match(/stripe-sync\s+v?([0-9]+\.[0-9]+\.[0-9]+)/)
  const version = versionMatch?.[1]
  let status: SchemaInstallationStatus
  let errorMessage: string | undefined
  if (comment.includes('uninstallation:error')) {
    status = 'uninstall error'
    errorMessage = comment.match(/uninstallation:error\s*-\s*(.+)$/)?.[1]
  } else if (comment.includes('uninstallation:started')) {
    status = 'uninstalling'
  } else if (comment.includes('installation:error')) {
    status = 'install error'
    errorMessage = comment.match(/installation:error\s*-\s*(.+)$/)?.[1]
  } else if (comment.includes('installation:started')) {
    status = 'installing'
  } else if (comment.includes('installed')) {
    status = 'installed'
  } else {
    return { status: 'uninstalled' }
  }
  return { status, oldVersion: undefined, newVersion: version, errorMessage }
}

const VERSION = '0.1.0'

const MGMT_API_BASE_RAW = Deno.env.get('MANAGEMENT_API_URL') || 'https://api.supabase.com'
const MGMT_API_BASE = MGMT_API_BASE_RAW.match(/^https?:\/\//)
  ? MGMT_API_BASE_RAW
  : `https://${MGMT_API_BASE_RAW}`

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

async function deleteEdgeFunction(
  projectRef: string,
  functionSlug: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/functions/${functionSlug}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    throw new Error(`Failed to delete function ${functionSlug}: ${response.status} ${text}`)
  }
}

async function deleteSecret(
  projectRef: string,
  secretName: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/secrets`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([secretName]),
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    console.warn(`Failed to delete secret ${secretName}: ${response.status} ${text}`)
  }
}

async function setSecrets(
  projectRef: string,
  secrets: Array<{ name: string; value: string }>,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/secrets`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(secrets),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to set secrets: ${response.status} ${text}`)
  }
}

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
// Route: POST /setup — install (migrations + webhook)
// ---------------------------------------------------------------------------

async function handleSetupPost(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return jsonResponse({ error: 'SUPABASE_URL not set' }, 500)
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const accessToken = authHeader.substring(7)

  let pool: pg.Pool | null = null
  try {
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }

    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName

    // Step 1: Run migrations
    await runMigrationsFromContent(
      {
        databaseUrl: dbUrl,
        schemaName,
        syncTablesSchemaName,
      },
      migrations
    )

    pool = new pg.Pool({ connectionString: dbUrl, max: 2 })

    // Release any stale advisory locks from previous timeouts
    await pool.query('SELECT pg_advisory_unlock_all()')

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
    const stripe = new Stripe(stripeKey)

    // Step 2: Create managed webhook endpoint via Stripe SDK
    const webhookUrl = `${supabaseUrl}/functions/v1/stripe-sync/webhook`

    const existing = await stripe.webhookEndpoints.list({ limit: 100 })
    const managed = existing.data.find(
      (wh) => wh.url === webhookUrl && wh.metadata?.managed_by === 'stripe-sync'
    )

    let webhookSecret = ''
    let webhookId = managed?.id
    if (!managed || managed.status !== 'enabled') {
      if (managed) {
        await stripe.webhookEndpoints.del(managed.id)
      }
      const endpoint = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: ['*'],
        metadata: { managed_by: 'stripe-sync' },
      })
      webhookSecret = endpoint.secret!
      webhookId = endpoint.id
    }

    // Step 3: Resolve account ID and store secrets
    const account = await stripe.accounts.retrieve()
    const secrets: Array<{ name: string; value: string }> = [
      { name: 'STRIPE_ACCOUNT_ID', value: account.id },
    ]
    if (webhookSecret) {
      secrets.push({ name: 'STRIPE_WEBHOOK_SECRET', value: webhookSecret })
    }
    await setSecrets(projectRef, secrets, accessToken)

    await pool.end()
    pool = null

    return jsonResponse({
      success: true,
      message: 'Setup complete',
      webhookId,
    })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Setup error:', error)
    if (pool) {
      try {
        await pool.query('SELECT pg_advisory_unlock_all()')
        await pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

// ---------------------------------------------------------------------------
// Route: GET /setup — status
// ---------------------------------------------------------------------------

async function handleSetupGet(_req: Request): Promise<Response> {
  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })

  try {
    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const commentResult = await pool.query(
      `SELECT obj_description(oid, 'pg_namespace') as comment
       FROM pg_namespace
       WHERE nspname = $1`,
      [schemaName]
    )

    const comment = commentResult.rows[0]?.comment || null

    let syncStatus: Array<Record<string, unknown>> = []
    if (comment) {
      try {
        const syncSchema = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
        const safeSchema = syncSchema.replace(/"/g, '""')
        const syncResult = await pool.query(`
          SELECT DISTINCT ON (account_id)
            account_id, started_at, closed_at, status, error_message,
            total_processed, total_objects, complete_count, error_count,
            running_count, pending_count, triggered_by, max_concurrent
          FROM "${safeSchema}"."sync_runs"
          ORDER BY account_id, started_at DESC
        `)
        syncStatus = syncResult.rows
      } catch (err) {
        console.warn('sync_runs query failed (may not exist yet):', err)
      }
    }

    const parsedComment = parseSchemaComment(comment)

    return new Response(
      JSON.stringify({
        package_version: VERSION,
        installation_status: parsedComment.status,
        sync_status: syncStatus,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  } catch (error: unknown) {
    const err = error as Error
    console.error('Status query error:', error)
    return jsonResponse(
      {
        error: err.message,
        package_version: VERSION,
        installation_status: 'not_installed',
      },
      500
    )
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Route: DELETE /setup — uninstall
// ---------------------------------------------------------------------------

async function handleSetupDelete(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return jsonResponse({ error: 'SUPABASE_URL not set' }, 500)
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const accessToken = authHeader.substring(7)

  let pool: pg.Pool | null = null
  try {
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required for uninstall')
    }

    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName

    pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
    const stripe = new Stripe(stripeKey)

    // Step 1: Delete all managed webhooks via Stripe SDK
    try {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
      for (const wh of endpoints.data) {
        if (wh.metadata?.managed_by === 'stripe-sync') {
          try {
            await stripe.webhookEndpoints.del(wh.id)
            console.log(`Deleted webhook: ${wh.id}`)
          } catch (err) {
            console.warn(`Could not delete webhook ${wh.id}:`, err)
          }
        }
      }
    } catch (err) {
      console.warn(`Could not get webhooks:`, err)
    }

    // Unschedule pg_cron jobs
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker') THEN
            PERFORM cron.unschedule('stripe-sync-worker');
          END IF;
          IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sigma-worker') THEN
            PERFORM cron.unschedule('stripe-sigma-worker');
          END IF;
        END $$;
      `)
    } catch (err) {
      console.warn('Could not unschedule pg_cron job:', err)
    }

    // Delete vault secrets
    try {
      await pool.query(`
        DELETE FROM vault.secrets
        WHERE name IN ('stripe_sync_worker_secret', 'stripe_sigma_worker_secret')
      `)
    } catch (err) {
      console.warn('Could not delete vault secret:', err)
    }

    // Drop Sigma self-trigger function if present
    try {
      const dropSchema = syncTablesSchemaName.replace(/"/g, '""')
      await pool.query(`DROP FUNCTION IF EXISTS "${dropSchema}".trigger_sigma_worker()`)
    } catch (err) {
      console.warn('Could not drop sigma trigger function:', err)
    }

    // Terminate connections holding locks on schema
    try {
      await pool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_locks l
         JOIN pg_class c ON l.relation = c.oid
         JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE n.nspname = $1 AND l.pid != pg_backend_pid()`,
        [syncTablesSchemaName]
      )
    } catch (err) {
      console.warn('Could not terminate connections:', err)
    }

    // Drop schema(s) with retry
    const schemasToDrop = [...new Set([schemaName, syncTablesSchemaName])]
    let dropAttempts = 0
    const maxAttempts = 3
    while (dropAttempts < maxAttempts) {
      try {
        for (const s of schemasToDrop) {
          const safe = s.replace(/"/g, '""')
          await pool.query(`DROP SCHEMA IF EXISTS "${safe}" CASCADE`)
        }
        break
      } catch (err: unknown) {
        const error = err as Error
        dropAttempts++
        if (dropAttempts >= maxAttempts) {
          throw new Error(
            `Failed to drop schema after ${maxAttempts} attempts. ` +
              `There may be active connections or locks on the stripe schema. ` +
              `Error: ${error.message}`
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    await pool.end()
    pool = null

    // Step 2: Delete Supabase secrets
    for (const secretName of [
      'STRIPE_SECRET_KEY',
      'MANAGEMENT_API_URL',
      'ENABLE_SIGMA',
      'STRIPE_ACCOUNT_ID',
      'STRIPE_WEBHOOK_SECRET',
    ]) {
      try {
        await deleteSecret(projectRef, secretName, accessToken)
      } catch (err) {
        console.warn(`Could not delete ${secretName} secret:`, err)
      }
    }

    // Step 3: Delete edge functions (current + legacy from before consolidation)
    for (const slug of [
      'stripe-sync',
      'stripe-setup',
      'stripe-webhook',
      'stripe-worker',
      'stripe-backfill-worker',
      'sigma-data-worker',
    ]) {
      try {
        await deleteEdgeFunction(projectRef, slug, accessToken)
      } catch (err) {
        console.warn(`Could not delete ${slug} function:`, err)
      }
    }

    return jsonResponse({ success: true, message: 'Uninstall complete' })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Uninstall error:', error)
    if (pool) {
      try {
        await pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

// ---------------------------------------------------------------------------
// Route: POST /webhook — process Stripe webhook event
// ---------------------------------------------------------------------------

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

  const sourceConfig: SourceConfig = {
    api_key: stripeKey,
    webhook_secret: webhookSecret,
  }
  const destConfig: DestConfig = {
    connection_string: dbUrl,
    schema: schemaName,
    port: 5432,
    batch_size: 100,
  }

  const stripe = new Stripe(stripeKey)
  const registry = buildResourceRegistry(stripe)
  const catalog = catalogFromRegistry(registry)

  try {
    const rawBody = new Uint8Array(await req.arrayBuffer())
    const messages = sourceStripe.read(
      { config: sourceConfig, catalog },
      (async function* () {
        yield { body: rawBody, signature: sig }
      })()
    )
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _stateMsg of destinationPostgres.write(
      { config: destConfig, catalog },
      messages
    )) {
      // state messages indicate committed records
    }
    return jsonResponse({ received: true })
  } catch (error: unknown) {
    const err = error as Error & { type?: string }
    console.error('Webhook processing error:', error)
    const isSignatureError =
      err.message?.includes('signature') || err.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return jsonResponse({ error: err.message }, status)
  }
}

// ---------------------------------------------------------------------------
// Route: POST /sync — cron coordinator (discovers streams, fans out to /backfill)
// ---------------------------------------------------------------------------

const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7

async function handleSync(req: Request): Promise<Response> {
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
  const stripe = new Stripe(stripeKey)
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
  const registry = buildResourceRegistry(stripe)

  try {
    // Auth: validate Bearer token against vault worker secret
    const authErr = await validateWorkerAuth(req, pool)
    if (authErr) {
      await pool.end()
      return authErr
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
      await pool.end()
      return jsonResponse({ skipped: true, message: msg })
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

    await pool.end()

    // Fan out: one worker per stream via /backfill route
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const backfillUrl = `${supabaseUrl}/functions/v1/stripe-sync/backfill`
    const authHeader = req.headers.get('Authorization')!

    await Promise.all(
      streams.map((stream) =>
        fetch(backfillUrl, {
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

    return jsonResponse({ sync_id: syncId, streams: streams.length, status: 'started' })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Sync coordinator error:', error)
    try {
      await pool.end()
    } catch {}
    return jsonResponse({ error: err.message }, 500)
  }
}

// ---------------------------------------------------------------------------
// Route: POST /backfill — per-stream backfill worker
//
// Future optimizations:
// - Make the initial /sync invocation in install() fire-and-forget so install
//   returns faster (currently blocks for up to 30s waiting for coordinator).
// - Tune PAGES_PER_INVOCATION based on observed cold-start times.
// - Consider returning a streaming response so the caller can observe progress.
// - Add exponential backoff on rate-limit errors instead of failing the stream.
// - Pool pg connections across invocations (module-level singleton).
// ---------------------------------------------------------------------------

const PAGES_PER_INVOCATION = Number(Deno.env.get('PAGES_PER_INVOCATION')) || 10

async function handleBackfill(req: Request): Promise<Response> {
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
  const stripe = new Stripe(stripeKey)
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 })
  const registry = buildResourceRegistry(stripe)

  // Auth: validate Bearer token against vault worker secret
  const authErr = await validateWorkerAuth(req, pool)
  if (authErr) {
    await pool.end()
    return authErr
  }

  // Parse request body
  const { sync_id: syncId, stream } = (await req.json()) as {
    sync_id: string
    stream: string
  }
  if (!syncId || !stream) {
    await pool.end()
    return new Response('Missing sync_id or stream', { status: 400 })
  }

  /** Find the resource config whose tableName matches the given stream name. */
  function findConfigByTableName(name: string) {
    const entry = Object.values(registry).find((cfg) => cfg.tableName === name)
    if (!entry) throw new Error(`Unknown stream: ${name}`)
    return entry
  }

  /**
   * Barrier-based completion check.
   * Atomically marks the sync run as complete if all streams have settled.
   */
  async function checkCompletion(): Promise<void> {
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
        await upsertMany(pool, schemaName, stream, response.data as Record<string, unknown>[])
        newRecords += response.data.length
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
      const backfillUrl = `${supabaseUrl}/functions/v1/stripe-sync/backfill`
      const authHeader = req.headers.get('Authorization')!
      fetch(backfillUrl, {
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
      await checkCompletion()
      console.log(`Stream ${stream}: complete — ${existingRecords + newRecords} total records`)
    }

    await pool.end()

    return jsonResponse({
      sync_id: syncId,
      stream,
      records: existingRecords + newRecords,
      has_more: hasMore,
    })
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
    await checkCompletion().catch((e) => console.error('Completion check failed:', e))

    try {
      await pool.end()
    } catch {}

    return jsonResponse({ error: errorMessage }, 500)
  }
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const url = new URL(req.url)
  // Last segment after /functions/v1/stripe-sync/
  const path = url.pathname.split('/').pop()

  if (path === 'webhook') return handleWebhook(req)

  if (path === 'setup') {
    if (req.method === 'GET') return handleSetupGet(req)
    if (req.method === 'POST') return handleSetupPost(req)
    if (req.method === 'DELETE') return handleSetupDelete(req)
    return new Response('Method not allowed', { status: 405 })
  }

  if (path === 'sync') return handleSync(req)
  if (path === 'backfill') return handleBackfill(req)

  return new Response('Not found', { status: 404 })
})
