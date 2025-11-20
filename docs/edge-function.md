# With Supabase Edge Functions

Create a new [Supabase](https://supabase.com) project and create a new [Edge Function](https://supabase.com/docs/guides/functions/quickstart).

## Prepare your database

Make sure to run the [migrations](../packages/sync-engine/src/database/migrations/), either by executing them manually, adding them into your CI, or running this locally once:

```ts
import { runMigrations } from '@supabase/stripe-sync-engine'
;(async () => {
  await runMigrations({
    databaseUrl: 'postgresql://postgres:..@db.<ref>.supabase.co:5432/postgre',
    logger: console,
  })
})()
```

## Usage

Sample code:

```ts
// Setup type definitions for built-in Supabase Runtime APIs
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { StripeSync } from 'npm:@supabase/stripe-sync-engine@0.37.2'

// Load secrets from environment variables
const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')!

// Initialize StripeSync
const stripeSync = new StripeSync({
  poolConfig: {
    connectionString: Deno.env.get('DATABASE_URL')!,
    max: 20,
    keepAlive: true,
    // optional SSL configuration
    ssl: {
      ca: Buffer.from(Deno.env.get('DATABASE_SSL_CA')!).toString('utf-8'),
    },
  },
  stripeWebhookSecret,
  stripeSecretKey,
  backfillRelatedEntities: false,
  autoExpandLists: true,
  maxPostgresConnections: 5,
})

Deno.serve(async (req) => {
  // Extract raw body as Uint8Array (buffer)
  const rawBody = new Uint8Array(await req.arrayBuffer())

  const stripeSignature = req.headers.get('stripe-signature')

  await stripeSync.processWebhook(rawBody, stripeSignature)

  return new Response(null, {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  })
})
```

Deploy your Edge Function initially.

Set up a Stripe webhook with the newly deployed Supabase Edge Function URL.

Create a new .env file in the `supabase` directory.

```.env
DATABASE_URL="postgresql://postgres:..@db.<ref>.supabase.co:5432/postgres"
DATABASE_SSL_CA="<base64-encoded-ca>"
STRIPE_WEBHOOK_SECRET="whsec_"
STRIPE_SECRET_KEY="sk_test_..."
```

Load the secrets:

```sh
supabase secrets set --env-file ./supabase/.env
```

> **Note:**
> Replace `<base64-encoded-ca>` with your actual base64-encoded certificate.

### Generating Base64 from CA Certificate

To generate a base64-encoded CA certificate, follow these steps:

1. Obtain the CA certificate file (e.g., `prod-ca-2021.crt`).
2. Use the following command on Unix-based systems:

   ```sh
   base64 -i prod-ca-2021.crt -o CA.base64
   ```

3. Open the `CA.base64` file and copy its contents.
4. Use the base64 string in your configuration or environment variables.
