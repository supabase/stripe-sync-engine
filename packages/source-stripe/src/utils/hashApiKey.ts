import { createHash } from 'node:crypto'

/**
 * Hashes a Stripe API key using SHA-256
 * Used to store API key hashes in the database for fast account lookups
 * without storing the actual API key or making Stripe API calls
 *
 * @param apiKey - The Stripe API key (e.g., sk_test_... or sk_live_...)
 * @returns SHA-256 hash of the API key as a hex string
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}
