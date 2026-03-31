/**
 * Stripe Webhook Edge Function
 *
 *   POST → process Stripe webhook event
 */

import sourceStripe, {
  type Config as SourceConfig,
  DEFAULT_SYNC_OBJECTS,
} from '@stripe/sync-source-stripe'
import destinationPostgres, { type Config as DestConfig } from '@stripe/sync-destination-postgres'

// ---------------------------------------------------------------------------
// Helpers (inlined — edge functions must be self-contained)
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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

  const catalog = {
    streams: DEFAULT_SYNC_OBJECTS.map((name) => ({
      stream: { name, primary_key: [['id']] },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append_dedup' as const,
    })),
  }

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
})
