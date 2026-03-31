/**
 * Stripe Setup Edge Function
 *
 *   POST   → install (run migrations, create webhook, store secrets)
 *   GET    → status (installation status + sync runs)
 *   DELETE → uninstall (drop schema, delete webhooks/secrets/functions)
 */

import { runMigrationsFromContent, migrations } from '@stripe/sync-state-postgres'
import Stripe from 'npm:stripe'
import pg from 'npm:pg@8'

// ---------------------------------------------------------------------------
// Helpers (inlined — edge functions must be self-contained)
// ---------------------------------------------------------------------------

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

interface AuthContext {
  supabaseUrl: string
  projectRef: string
  accessToken: string
}

function extractAuthContext(req: Request): AuthContext | Response {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return jsonResponse({ error: 'SUPABASE_URL not set' }, 500)
  }
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  return {
    supabaseUrl,
    projectRef: new URL(supabaseUrl).hostname.split('.')[0],
    accessToken: authHeader.substring(7),
  }
}

function mgmtHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

async function deleteEdgeFunction(
  projectRef: string,
  functionSlug: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/functions/${functionSlug}`
  const response = await fetch(url, { method: 'DELETE', headers: mgmtHeaders(accessToken) })

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
    headers: mgmtHeaders(accessToken),
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
    headers: mgmtHeaders(accessToken),
    body: JSON.stringify(secrets),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to set secrets: ${response.status} ${text}`)
  }
}

// ---------------------------------------------------------------------------
// POST /setup — install (migrations + webhook)
// ---------------------------------------------------------------------------

async function handleSetupPost(req: Request): Promise<Response> {
  const ctx = extractAuthContext(req)
  if (ctx instanceof Response) return ctx
  const { supabaseUrl, projectRef, accessToken } = ctx

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

    // Clear skip_until so cron resumes immediately after reinstall
    try {
      await pool.query(`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`)
    } catch (err) {
      console.warn('Could not delete skip_until vault secret:', err)
    }

    // Clear stale sync state so the new install starts fresh
    const safeSchema = schemaName.replace(/"/g, '""')
    try {
      await pool.query(`DELETE FROM "${safeSchema}"."_sync_state" WHERE sync_id = 'default'`)
    } catch {
      // Table may not exist yet on first install — safe to ignore
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
    const stripe = new Stripe(stripeKey)

    // Step 2: Create managed webhook endpoint via Stripe SDK
    const webhookUrl = `${supabaseUrl}/functions/v1/stripe-webhook`

    const existing = await stripe.webhookEndpoints.list({ limit: 100 })
    const managedWebhooks = existing.data.filter((wh) => wh.metadata?.managed_by === 'stripe-sync')

    // Clean up webhooks pointing to old URLs (e.g. /stripe-worker/webhook)
    for (const old of managedWebhooks.filter((wh) => wh.url !== webhookUrl)) {
      try {
        await stripe.webhookEndpoints.del(old.id)
        console.log(`Deleted legacy webhook ${old.id} (${old.url})`)
      } catch (err) {
        console.warn(`Could not delete legacy webhook ${old.id}:`, err)
      }
    }

    const current = managedWebhooks.find((wh) => wh.url === webhookUrl)
    let webhookSecret = ''
    let webhookId = current?.id
    if (!current || current.status !== 'enabled') {
      if (current) {
        await stripe.webhookEndpoints.del(current.id)
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
// GET /setup — status
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
// DELETE /setup — uninstall
// ---------------------------------------------------------------------------

async function handleSetupDelete(req: Request): Promise<Response> {
  const ctx = extractAuthContext(req)
  if (ctx instanceof Response) return ctx
  const { projectRef, accessToken } = ctx

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

    // Step 3: Delete edge functions (current + legacy)
    for (const slug of [
      'stripe-setup',
      'stripe-webhook',
      'stripe-sync',
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
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'GET') return handleSetupGet(req)
  if (req.method === 'POST') return handleSetupPost(req)
  if (req.method === 'DELETE') return handleSetupDelete(req)
  return new Response('Method not allowed', { status: 405 })
})
