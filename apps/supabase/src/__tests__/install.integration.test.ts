// NOTE: This test is intentionally NOT run in GitHub CI.
// SUPABASE_PERSONAL_ACCESS_TOKEN is a user-scoped PAT with broad management API access
// (deploy, delete, run SQL on any project under the account). Using it in CI would
// require storing a high-privilege secret in the repo. To enable CI, create a dedicated
// Supabase service account with a scoped PAT and store that as a CI secret instead.
import { afterAll, describe, expect, it } from 'vitest'
import { SupabaseSetupClient } from '../supabase'

const projectRef = process.env.SUPABASE_PROJECT_ID
const accessToken = process.env.SUPABASE_PERSONAL_ACCESS_TOKEN
const stripeKey = process.env.STRIPE_API_KEY

describe.skipIf(!projectRef || !accessToken || !stripeKey)('Supabase install / uninstall', () => {
  const client = new SupabaseSetupClient({ accessToken: accessToken!, projectRef: projectRef! })

  // Safety net: uninstall if a test fails mid-way and leaves the project dirty
  afterAll(async () => {
    try {
      if (await client.isInstalled()) {
        await client.uninstall()
      }
    } catch {
      // best-effort cleanup
    }
  })

  it('installs and reports isInstalled = true', async () => {
    await client.install(stripeKey!)
    expect(await client.isInstalled()).toBe(true)
  }, 120_000)

  it('uninstalls and reports isInstalled = false', async () => {
    await client.uninstall()
    expect(await client.isInstalled()).toBe(false)
  }, 60_000)
})
