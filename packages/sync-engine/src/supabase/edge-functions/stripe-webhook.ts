import { StripeSync } from '../../index'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), { status: 500 })
  }

  const stripeSync = new StripeSync({
    poolConfig: { connectionString: dbUrl, max: 1 },
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
  })

  try {
    const rawBody = new Uint8Array(await req.arrayBuffer())
    await stripeSync.processWebhook(rawBody, sig)
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    const isSignatureError =
      error.message?.includes('signature') || error.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } finally {
    await stripeSync.postgresClient.pool.end()
  }
})
