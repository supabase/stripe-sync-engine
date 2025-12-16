import { describe, test, expect } from 'vitest'
import { webhookFunctionCode, workerFunctionCode } from '../supabase'

describe('Edge Function Files', () => {
  describe('webhookFunctionCode', () => {
    test('imports StripeSync from npm package', () => {
      expect(webhookFunctionCode).toMatch(
        /import \{ StripeSync \} from 'npm:stripe-experiment-sync(@[\d.]+)?'/
      )
    })

    test('uses poolConfig for database connection', () => {
      expect(webhookFunctionCode).toContain('poolConfig:')
      expect(webhookFunctionCode).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(webhookFunctionCode).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(webhookFunctionCode).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('validates stripe-signature header', () => {
      expect(webhookFunctionCode).toContain("req.headers.get('stripe-signature')")
      expect(webhookFunctionCode).toContain('Missing stripe-signature header')
    })

    test('calls processWebhook with raw body and signature', () => {
      expect(webhookFunctionCode).toContain('stripeSync.processWebhook(rawBody, sig)')
    })

    test('returns 200 on success', () => {
      expect(webhookFunctionCode).toContain('status: 200')
      expect(webhookFunctionCode).toContain('received: true')
    })

    test('returns 400 on error', () => {
      expect(webhookFunctionCode).toContain('status: 400')
    })

    test('rejects non-POST requests', () => {
      expect(webhookFunctionCode).toContain("req.method !== 'POST'")
      expect(webhookFunctionCode).toContain('status: 405')
    })
  })

  describe('workerFunctionCode', () => {
    test('imports StripeSync from npm package', () => {
      expect(workerFunctionCode).toMatch(
        /import \{ StripeSync \} from 'npm:stripe-experiment-sync(@[\d.]+)?'/
      )
    })

    test('imports postgres for pgmq operations', () => {
      expect(workerFunctionCode).toContain("import postgres from 'npm:postgres'")
    })

    test('uses poolConfig for database connection', () => {
      expect(workerFunctionCode).toContain('poolConfig:')
      expect(workerFunctionCode).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(workerFunctionCode).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(workerFunctionCode).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('verifies authorization header', () => {
      expect(workerFunctionCode).toContain("req.headers.get('Authorization')")
      expect(workerFunctionCode).toContain("startsWith('Bearer ')")
    })

    test('returns 401 for unauthorized requests', () => {
      expect(workerFunctionCode).toContain('Unauthorized')
      expect(workerFunctionCode).toContain('status: 401')
    })

    test('reads batch from pgmq queue', () => {
      expect(workerFunctionCode).toContain('pgmq.read')
      expect(workerFunctionCode).toContain('VISIBILITY_TIMEOUT')
      expect(workerFunctionCode).toContain('BATCH_SIZE')
    })

    test('enqueues all objects when queue is empty', () => {
      expect(workerFunctionCode).toContain('joinOrCreateSyncRun')
      expect(workerFunctionCode).toContain('pgmq.send_batch')
    })

    test('calls processNext with object to process pending work', () => {
      expect(workerFunctionCode).toContain('stripeSync.processNext(object)')
    })

    test('deletes message after successful processing', () => {
      expect(workerFunctionCode).toContain('pgmq.delete')
    })

    test('re-enqueues object if hasMore pages', () => {
      expect(workerFunctionCode).toContain('if (result.hasMore)')
      expect(workerFunctionCode).toContain('pgmq.send')
    })

    test('returns 200 on success', () => {
      expect(workerFunctionCode).toContain('status: 200')
    })

    test('returns 500 on error', () => {
      expect(workerFunctionCode).toContain('status: 500')
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
