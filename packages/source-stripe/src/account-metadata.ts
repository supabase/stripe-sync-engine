import type { StripeClient } from './client.js'
import type { Config } from './spec.js'

export const STRIPE_LAUNCH_TIMESTAMP = Math.floor(new Date('2011-01-01T00:00:00Z').getTime() / 1000)

export async function resolveAccountMetadata(
  config: Config,
  client: StripeClient
): Promise<{
  accountId: string
  accountCreated: number
  updatedConfig?: Config
}> {
  const needsAccountId = !config.account_id
  const needsAccountCreated = config.account_created == null

  let accountId = config.account_id
  let accountCreated = config.account_created

  if (needsAccountId || needsAccountCreated) {
    try {
      const account = await client.getAccount({ maxRetries: 0 })
      accountId ??= account.id
      accountCreated ??= account.created ?? STRIPE_LAUNCH_TIMESTAMP
    } catch (err) {
      // account_id is required — rethrow if we can't resolve it
      if (needsAccountId) throw err
      // account_created is best-effort — fall back to epoch if account_id is known
      accountCreated ??= STRIPE_LAUNCH_TIMESTAMP
    }
  }

  return {
    accountId: accountId!,
    accountCreated: accountCreated ?? STRIPE_LAUNCH_TIMESTAMP,
    updatedConfig:
      needsAccountId || needsAccountCreated
        ? { ...config, account_id: accountId!, account_created: accountCreated }
        : undefined,
  }
}
