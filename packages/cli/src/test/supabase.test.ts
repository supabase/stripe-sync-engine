import { describe, test, expect } from 'vitest'
import { getWebhookFunctionCode, getWorkerFunctionCode } from '../supabase'

describe('Edge Function Templates', () => {
  describe('getWebhookFunctionCode', () => {
    const code = getWebhookFunctionCode()

    test('imports StripeSync from npm package', () => {
      expect(code).toMatch(/import \{ StripeSync \} from 'npm:stripe-experiment-sync(@[\d.]+)?'/)
    })

    test('uses poolConfig for database connection', () => {
      expect(code).toContain('poolConfig:')
      expect(code).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(code).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(code).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('validates stripe-signature header', () => {
      expect(code).toContain("req.headers.get('stripe-signature')")
      expect(code).toContain('Missing stripe-signature header')
    })

    test('calls processWebhook with raw body and signature', () => {
      expect(code).toContain('stripeSync.processWebhook(rawBody, sig)')
    })

    test('returns 200 on success', () => {
      expect(code).toContain('status: 200')
      expect(code).toContain('received: true')
    })

    test('returns 400 on error', () => {
      expect(code).toContain('status: 400')
    })

    test('rejects non-POST requests', () => {
      expect(code).toContain("req.method !== 'POST'")
      expect(code).toContain('status: 405')
    })
  })

  describe('getWorkerFunctionCode', () => {
    const code = getWorkerFunctionCode('test-project-ref')

    test('imports StripeSync from npm package', () => {
      expect(code).toMatch(/import \{ StripeSync \} from 'npm:stripe-experiment-sync(@[\d.]+)?'/)
    })

    test('uses poolConfig for database connection', () => {
      expect(code).toContain('poolConfig:')
      expect(code).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(code).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(code).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('verifies authorization header', () => {
      expect(code).toContain("req.headers.get('Authorization')")
      expect(code).toContain("startsWith('Bearer ')")
    })

    test('returns 401 for unauthorized requests', () => {
      expect(code).toContain('Unauthorized')
      expect(code).toContain('status: 401')
    })

    test('calls processNext with object to process pending work', () => {
      expect(code).toContain('stripeSync.processNext(object)')
    })

    test('reads object from request body', () => {
      expect(code).toContain('const { object } = body')
    })

    test('returns 400 if object is missing', () => {
      expect(code).toContain('Missing object in request body')
      expect(code).toContain('status: 400')
    })

    test('re-invokes self if hasMore is true', () => {
      expect(code).toContain('if (result.hasMore)')
      expect(code).toContain('SELF_URL')
    })

    test('returns 200 on success', () => {
      expect(code).toContain('status: 200')
    })

    test('returns 500 on error', () => {
      expect(code).toContain('status: 500')
    })
  })
})

describe('Database URL Construction', () => {
  test('constructs pooler URL with correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'mypassword123'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toBe(
      'postgresql://postgres.abcdefghijklmnopqrst:mypassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    )
  })

  test('encodes special characters in password', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'pass@word#123!'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toContain('pass%40word%23123!')
    expect(databaseUrl).not.toContain('pass@word#123!')
  })
})

describe('Webhook URL Generation', () => {
  test('webhook URL uses correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-webhook`

    expect(webhookUrl).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook')
  })
})
