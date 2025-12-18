/**
 * Local Sigma sync test script.
 *
 * Run:
 *   DATABASE_URL=... STRIPE_SECRET_KEY=... pnpm -C packages/cli exec tsx scripts/sigma-sync-local.ts
 */

import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StripeSync, runMigrations, hashApiKey, SyncObject } from 'stripe-experiment-sync'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true })

async function main() {
  const databaseUrl = process.env.DATABASE_URL!
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY!
  const object = (process.env.SIGMA_OBJECT ||
    'subscription_item_change_events_v2_beta') as SyncObject

  await runMigrations({ databaseUrl })

  const stripeSync = new StripeSync({
    databaseUrl,
    stripeSecretKey,
    enableSigma: true,
    poolConfig: { connectionString: databaseUrl, max: 5, keepAlive: true },
  })

  const accountId = process.env.STRIPE_ACCOUNT_ID || (await stripeSync.getAccountId())
  await stripeSync.postgresClient.upsertAccount(
    { id: accountId, raw_data: { id: accountId, object: 'account' } },
    hashApiKey(stripeSecretKey)
  )

  const result = await stripeSync.processUntilDone({ object })
  console.log(JSON.stringify({ result }, null, 2))

  await stripeSync.close()
}

main()
