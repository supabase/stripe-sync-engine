// TODO: Not yet running in GitHub CI.
// To enable: create a dedicated Supabase service account with a scoped PAT
// and store SUPABASE_PROJECT_ID + SUPABASE_PERSONAL_ACCESS_TOKEN + STRIPE_API_KEY as CI secrets.
import { afterAll, expect, it } from 'vitest'
import { SupabaseSetupClient } from '../supabase'
import { describeWithEnv } from '../../../../tests/test-helpers'

describeWithEnv(
  'Supabase install / uninstall',
  ['SUPABASE_PROJECT_ID', 'SUPABASE_PERSONAL_ACCESS_TOKEN', 'STRIPE_API_KEY'],
  ({ SUPABASE_PROJECT_ID, SUPABASE_PERSONAL_ACCESS_TOKEN, STRIPE_API_KEY }) => {
    const client = new SupabaseSetupClient({
      accessToken: SUPABASE_PERSONAL_ACCESS_TOKEN,
      projectRef: SUPABASE_PROJECT_ID,
    })

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
      await client.install(STRIPE_API_KEY)
      expect(await client.isInstalled()).toBe(true)
    }, 120_000)

    it('uninstalls and reports isInstalled = false', async () => {
      await client.uninstall()
      expect(await client.isInstalled()).toBe(false)
    }, 60_000)
  }
)
