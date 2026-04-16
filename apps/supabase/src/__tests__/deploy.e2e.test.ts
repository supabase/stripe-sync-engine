// TODO: Not yet running in GitHub CI.
// To enable: create a dedicated Supabase service account with a scoped PAT
// and store SUPABASE_PROJECT_ID + SUPABASE_PERSONAL_ACCESS_TOKEN as CI secrets.
import { it, expect } from 'vitest'
import { SupabaseSetupClient } from '../supabase.js'
import { describeWithEnv } from '../../../../tests/test-helpers.js'

describeWithEnv(
  'Supabase deploy',
  ['SUPABASE_PROJECT_ID', 'SUPABASE_PERSONAL_ACCESS_TOKEN'],
  ({ SUPABASE_PROJECT_ID, SUPABASE_PERSONAL_ACCESS_TOKEN }) => {
    const client = new SupabaseSetupClient({
      accessToken: SUPABASE_PERSONAL_ACCESS_TOKEN,
      projectRef: SUPABASE_PROJECT_ID,
    })
    const slug = `test-hello-${Date.now()}`

    it('deploys, invokes, and deletes an edge function', async () => {
      // Deploy
      await client.deployFunction(slug, `Deno.serve(() => new Response("ok"))`)

      // Invoke
      const url = `https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/${slug}`
      const res = await fetch(url)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')

      // Cleanup
      await client.api.deleteAFunction(SUPABASE_PROJECT_ID, slug)
    }, 30_000)
  }
)
