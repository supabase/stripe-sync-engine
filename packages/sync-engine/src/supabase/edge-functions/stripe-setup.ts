import { StripeSync, runMigrations } from 'npm:stripe-experiment-sync'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
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
