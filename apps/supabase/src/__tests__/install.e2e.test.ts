// TODO: Not yet running in GitHub CI.
// To enable: create a dedicated Supabase service account with a scoped PAT
// and store SUPABASE_PROJECT_ID + SUPABASE_PERSONAL_ACCESS_TOKEN + STRIPE_API_KEY as CI secrets.
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
