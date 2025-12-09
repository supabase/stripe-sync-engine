import { NextRequest, NextResponse } from 'next/server'
import {
  SupabaseDeployClient,
  setupFunctionCode,
  webhookFunctionCode,
  workerFunctionCode,
} from '@supabase/stripe-sync-cli/lib'
import { createSession } from '@/lib/sessions'

interface DeployRequest {
  supabaseAccessToken: string
  supabaseProjectRef: string
  stripeKey: string
}

export async function POST(request: NextRequest) {
  try {
    const body: DeployRequest = await request.json()
    const { supabaseAccessToken, supabaseProjectRef, stripeKey } = body

    if (!supabaseAccessToken || !supabaseProjectRef || !stripeKey) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const trimmedStripeKey = stripeKey.trim()
    if (!trimmedStripeKey.startsWith('sk_') && !trimmedStripeKey.startsWith('rk_')) {
      return NextResponse.json(
        { error: 'Stripe key should start with "sk_" or "rk_"' },
        { status: 400 }
      )
    }

    const client = new SupabaseDeployClient({
      accessToken: supabaseAccessToken,
      projectRef: supabaseProjectRef,
    })

    // Validate project
    await client.validateProject()

    // Deploy Edge Functions
    await client.deployFunction('stripe-setup', setupFunctionCode)
    await client.deployFunction('stripe-webhook', webhookFunctionCode)
    await client.deployFunction('stripe-worker', workerFunctionCode)

    // Set secrets
    await client.setSecrets([{ name: 'STRIPE_SECRET_KEY', value: trimmedStripeKey }])

    // Run setup
    const serviceRoleKey = await client.getServiceRoleKey()
    const setupResult = await client.invokeFunction('stripe-setup', serviceRoleKey)

    if (!setupResult.success) {
      return NextResponse.json({ error: `Setup failed: ${setupResult.error}` }, { status: 500 })
    }

    // Setup pg_cron
    try {
      await client.setupPgCronJob()
    } catch {
      // pg_cron may not be available
    }

    // Create session to store credentials server-side (for Management API queries)
    const sessionId = createSession(supabaseProjectRef, supabaseAccessToken)

    return NextResponse.json({
      success: true,
      sessionId,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
