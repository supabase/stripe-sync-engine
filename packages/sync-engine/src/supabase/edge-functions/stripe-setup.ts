import { StripeSync, runMigrations, VERSION } from 'npm:stripe-experiment-sync'
import postgres from 'npm:postgres'

// Get management API base URL from environment variable (for testing against localhost/staging)
// Caller should provide full URL with protocol (e.g., http://localhost:54323 or https://api.supabase.com)
const MGMT_API_BASE_RAW = Deno.env.get('SUPABASE_MANAGEMENT_URL') || 'https://api.supabase.com'
const MGMT_API_BASE = MGMT_API_BASE_RAW.match(/^https?:\/\//)
  ? MGMT_API_BASE_RAW
  : `https://${MGMT_API_BASE_RAW}`

// Helper to validate accessToken against Management API
async function validateAccessToken(projectRef: string, accessToken: string): Promise<boolean> {
  // Try to fetch project details using the access token
  // This validates that the token is valid for the management API
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  // If we can successfully get the project, the token is valid
  return response.ok
}

// Helper to delete edge function via Management API
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

// Helper to delete secrets via Management API
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

Deno.serve(async (req) => {
  // Extract project ref from SUPABASE_URL (format: https://{projectRef}.{base})
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_URL not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  // Validate access token for all requests
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const accessToken = authHeader.substring(7) // Remove 'Bearer '
  const isValid = await validateAccessToken(projectRef, accessToken)
  if (!isValid) {
    return new Response('Forbidden: Invalid access token for this project', { status: 403 })
  }

  // Handle GET requests for status
  if (req.method === 'GET') {
    const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!rawDbUrl) {
      return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')
    let sql

    try {
      sql = postgres(dbUrl, { max: 1, prepare: false })

      // Query installation status from schema comment
      const commentResult = await sql`
        SELECT obj_description(oid, 'pg_namespace') as comment
        FROM pg_namespace
        WHERE nspname = 'stripe'
      `

      const comment = commentResult[0]?.comment || null
      let installationStatus = 'not_installed'

      if (comment && comment.includes('stripe-sync')) {
        // Parse installation status from comment
        if (comment.includes('installation:started')) {
          installationStatus = 'installing'
        } else if (comment.includes('installation:error')) {
          installationStatus = 'error'
        } else if (comment.includes('installed')) {
          installationStatus = 'installed'
        }
      }

      // Query sync runs (only if schema exists)
      let syncStatus = []
      if (comment) {
        try {
          syncStatus = await sql`
            SELECT DISTINCT ON (account_id)
              account_id, started_at, closed_at, status, error_message,
              total_processed, total_objects, complete_count, error_count,
              running_count, pending_count, triggered_by, max_concurrent
            FROM stripe.sync_runs
            ORDER BY account_id, started_at DESC
          `
        } catch (err) {
          // Ignore errors if sync_runs view doesn't exist yet
          console.warn('sync_runs query failed (may not exist yet):', err)
        }
      }

      return new Response(
        JSON.stringify({
          package_version: VERSION,
          installation_status: installationStatus,
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
    } catch (error) {
      console.error('Status query error:', error)
      return new Response(
        JSON.stringify({
          error: error.message,
          package_version: VERSION,
          installation_status: 'not_installed',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } finally {
      if (sql) await sql.end()
    }
  }

  // Handle DELETE requests for uninstall
  if (req.method === 'DELETE') {
    let stripeSync = null
    try {
      // Get and validate database URL
      const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
      if (!rawDbUrl) {
        throw new Error('SUPABASE_DB_URL environment variable is not set')
      }
      // Remove sslmode from connection string (not supported by pg in Deno)
      const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

      // Stripe key is required for uninstall to delete webhooks
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
      if (!stripeKey) {
        throw new Error('STRIPE_SECRET_KEY environment variable is required for uninstall')
      }

      // Step 1: Delete Stripe webhooks and clean up database
      stripeSync = new StripeSync({
        poolConfig: { connectionString: dbUrl, max: 2 },
        stripeSecretKey: stripeKey,
      })

      // Delete all managed webhooks
      const webhooks = await stripeSync.listManagedWebhooks()
      for (const webhook of webhooks) {
        try {
          await stripeSync.deleteManagedWebhook(webhook.id)
          console.log(`Deleted webhook: ${webhook.id}`)
        } catch (err) {
          console.warn(`Could not delete webhook ${webhook.id}:`, err)
        }
      }

      // Unschedule pg_cron job
      try {
        await stripeSync.postgresClient.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker') THEN
              PERFORM cron.unschedule('stripe-sync-worker');
            END IF;
          END $$;
        `)
      } catch (err) {
        console.warn('Could not unschedule pg_cron job:', err)
      }

      // Delete vault secret
      try {
        await stripeSync.postgresClient.query(`
          DELETE FROM vault.secrets
          WHERE name = 'stripe_sync_worker_secret'
        `)
      } catch (err) {
        console.warn('Could not delete vault secret:', err)
      }

      // Terminate connections holding locks on stripe schema
      try {
        await stripeSync.postgresClient.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_locks l
          JOIN pg_class c ON l.relation = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = 'stripe'
            AND l.pid != pg_backend_pid()
        `)
      } catch (err) {
        console.warn('Could not terminate connections:', err)
      }

      // Drop schema with retry
      let dropAttempts = 0
      const maxAttempts = 3
      while (dropAttempts < maxAttempts) {
        try {
          await stripeSync.postgresClient.query('DROP SCHEMA IF EXISTS stripe CASCADE')
          break // Success, exit loop
        } catch (err) {
          dropAttempts++
          if (dropAttempts >= maxAttempts) {
            throw new Error(
              `Failed to drop schema after ${maxAttempts} attempts. ` +
                `There may be active connections or locks on the stripe schema. ` +
                `Error: ${err.message}`
            )
          }
          // Wait 1 second before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      await stripeSync.postgresClient.pool.end()

      // Step 2: Delete Supabase secrets
      try {
        await deleteSecret(projectRef, 'STRIPE_SECRET_KEY', accessToken)
      } catch (err) {
        console.warn('Could not delete STRIPE_SECRET_KEY secret:', err)
      }

      // Step 3: Delete Edge Functions
      try {
        await deleteEdgeFunction(projectRef, 'stripe-setup', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-setup function:', err)
      }

      try {
        await deleteEdgeFunction(projectRef, 'stripe-webhook', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-webhook function:', err)
      }

      try {
        await deleteEdgeFunction(projectRef, 'stripe-worker', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-worker function:', err)
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Uninstall complete',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } catch (error) {
      console.error('Uninstall error:', error)
      // Cleanup on error
      if (stripeSync) {
        try {
          await stripeSync.postgresClient.pool.end()
        } catch (cleanupErr) {
          console.warn('Cleanup failed:', cleanupErr)
        }
      }
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // Handle POST requests for install
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let stripeSync = null
  try {
    // Get and validate database URL
    const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!rawDbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }
    // Remove sslmode from connection string (not supported by pg in Deno)
    const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

    await runMigrations({ databaseUrl: dbUrl })

    stripeSync = new StripeSync({
      poolConfig: { connectionString: dbUrl, max: 2 }, // Need 2 for advisory lock + queries
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY'),
    })

    // Release any stale advisory locks from previous timeouts
    await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')

    // Construct webhook URL from SUPABASE_URL (available in all Edge Functions)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL environment variable is not set')
    }
    const webhookUrl = supabaseUrl + '/functions/v1/stripe-webhook'

    const webhook = await stripeSync.findOrCreateManagedWebhook(webhookUrl)

    await stripeSync.postgresClient.pool.end()

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Setup complete',
        webhookId: webhook.id,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Setup error:', error)
    // Cleanup on error
    if (stripeSync) {
      try {
        await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')
        await stripeSync.postgresClient.pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
