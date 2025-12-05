import { StripeSync } from 'npm:stripe-experiment-sync'

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { object } = body

  if (!object) {
    return new Response(JSON.stringify({ error: 'Missing object in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!rawDbUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), { status: 500 })
  }
  const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

  const stripeSync = new StripeSync({
    poolConfig: { connectionString: dbUrl, max: 1 },
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
  })

  try {
    const result = await stripeSync.processNext(object)

    // If more pages, re-invoke self
    if (result.hasMore) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      fetch(`${supabaseUrl}/functions/v1/stripe-worker`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ object }),
      }).catch((err) => console.error('Failed to re-invoke worker for', object, err))
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Worker error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  } finally {
    await stripeSync.postgresClient.pool.end()
  }
})
