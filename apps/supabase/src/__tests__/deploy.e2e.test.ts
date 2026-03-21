// TODO: Not yet running in GitHub CI.
// To enable: create a dedicated Supabase service account with a scoped PAT
// and store SUPABASE_PROJECT_ID + SUPABASE_PERSONAL_ACCESS_TOKEN as CI secrets.
import { describe, it, expect } from 'vitest'
import { SupabaseSetupClient } from '../supabase'

const projectRef = process.env.SUPABASE_PROJECT_ID
const accessToken = process.env.SUPABASE_PERSONAL_ACCESS_TOKEN

describe.skipIf(!projectRef || !accessToken)('Supabase deploy', () => {
  const client = new SupabaseSetupClient({ accessToken: accessToken!, projectRef: projectRef! })
  const slug = `test-hello-${Date.now()}`

  it('deploys, invokes, and deletes an edge function', async () => {
    // Deploy
    await client.deployFunction(slug, `Deno.serve(() => new Response("ok"))`)

    // Invoke
    const url = `https://${projectRef}.supabase.co/functions/v1/${slug}`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')

    // Cleanup
    await client.api.deleteAFunction(projectRef!, slug)
  }, 30_000)
})
