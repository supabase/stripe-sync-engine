import { StripeSync, runMigrations, VERSION } from 'npm:stripe-experiment-sync'
import postgres from 'npm:postgres'

Deno.serve(async (req) => {
  // Require authentication for both GET and POST
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
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

  // Handle POST requests for setup (existing logic)
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
