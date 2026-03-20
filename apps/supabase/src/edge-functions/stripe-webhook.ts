import sourceStripe, {
  type Config as SourceConfig,
  buildResourceRegistry,
} from '@stripe/source-stripe'
import destinationPostgres, { type Config as DestConfig } from '@stripe/destination-postgres'
import { catalogFromRegistry } from '@stripe/source-stripe'
import Stripe from 'npm:stripe'

Deno.serve(async (req) => {
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
    return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), { status: 500 })
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
    // source.read with input processes a single webhook event through the full pipeline
    const messages = sourceStripe.read({
      config: sourceConfig,
      catalog,
      input: { body: rawBody, signature: sig },
    })
    // Pipe records into destination.write
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _stateMsg of destinationPostgres.write(
      { config: destConfig, catalog },
      messages
    )) {
      // state messages indicate committed records
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error: unknown) {
    const err = error as Error & { type?: string }
    console.error('Webhook processing error:', error)
    const isSignatureError =
      err.message?.includes('signature') || err.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
