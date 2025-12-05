import { StripeSync } from 'npm:stripe-experiment-sync'

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_URL not set' }), { status: 500 })
  }
  const workerUrl = `${supabaseUrl}/functions/v1/stripe-worker`

  // StripeSync just needed for getSupportedSyncObjects() - no DB connection required
  const stripeSync = new StripeSync({
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
  })

  try {
    const objects = stripeSync.getSupportedSyncObjects()

    // Invoke worker for each object type (fire-and-forget)
    for (const object of objects) {
      fetch(workerUrl, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ object }),
      }).catch((err) => console.error('Failed to invoke worker for', object, err))
    }

    return new Response(JSON.stringify({ scheduled: objects }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Scheduler error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
