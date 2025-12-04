import { SupabaseManagementAPI } from 'supabase-management-js'

// Edge Function templates for Supabase deployment

export function getSetupFunctionCode(projectRef: string): string {
  const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-webhook`
  return `import { StripeSync, runMigrations } from 'npm:stripe-experiment-sync'

const WEBHOOK_URL = '${webhookUrl}'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  let stripeSync = null
  try {
    // Get and validate database URL
    const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!rawDbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }
    // Remove sslmode from connection string (not supported by pg in Deno)
    const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

    await runMigrations({ databaseUrl: dbUrl })

    stripeSync = new StripeSync({
      poolConfig: { connectionString: dbUrl, max: 2 },  // Need 2 for advisory lock + queries
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY'),
    })

    // Release any stale advisory locks from previous timeouts
    await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')

    const webhook = await stripeSync.findOrCreateManagedWebhook(WEBHOOK_URL)

    await stripeSync.postgresClient.pool.end()

    return new Response(JSON.stringify({
      success: true,
      message: 'Setup complete',
      webhookId: webhook.id,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Setup error:', error)
    // Cleanup on error
    if (stripeSync) {
      try {
        await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')
        await stripeSync.postgresClient.pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export function getWebhookFunctionCode(): string {
  return `import { StripeSync } from 'npm:stripe-experiment-sync'

// Get and validate database URL at startup
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!rawDbUrl) {
  throw new Error('SUPABASE_DB_URL environment variable is not set')
}
// Remove sslmode from connection string (not supported by pg in Deno)
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

const stripeSync = new StripeSync({
  poolConfig: { connectionString: dbUrl, max: 5 },  // Higher pool for concurrent webhook processing
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  try {
    const rawBody = new Uint8Array(await req.arrayBuffer())
    await stripeSync.processWebhook(rawBody, sig)
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    // Use 400 for signature verification failures (client error),
    // 500 for internal processing errors
    const isSignatureError = error.message?.includes('signature') || error.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export function getSchedulerFunctionCode(projectRef: string): string {
  const workerUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-worker`
  return `import { StripeSync } from 'npm:stripe-experiment-sync'

const WORKER_URL = '${workerUrl}'

// Get and validate database URL at startup
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!rawDbUrl) {
  throw new Error('SUPABASE_DB_URL environment variable is not set')
}
// Remove sslmode from connection string (not supported by pg in Deno)
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

const stripeSync = new StripeSync({
  poolConfig: { connectionString: dbUrl, max: 2 },
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  // Verify authorization (service role key from pg_cron)
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const objects = stripeSync.getSupportedSyncObjects()

    // Invoke worker for each object type (fire-and-forget)
    for (const object of objects) {
      fetch(WORKER_URL, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ object }),
      }).catch((err) => console.error('Failed to invoke worker for', object, err))
    }

    return new Response(JSON.stringify({ scheduled: objects }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Scheduler error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export function getWorkerFunctionCode(projectRef: string): string {
  const selfUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-worker`
  return `import { StripeSync } from 'npm:stripe-experiment-sync'

const SELF_URL = '${selfUrl}'

// Get and validate database URL at startup
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!rawDbUrl) {
  throw new Error('SUPABASE_DB_URL environment variable is not set')
}
// Remove sslmode from connection string (not supported by pg in Deno)
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

const stripeSync = new StripeSync({
  poolConfig: { connectionString: dbUrl, max: 5 },  // Higher pool for concurrent processing
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  // Verify authorization (service role key)
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { object } = body

    if (!object) {
      return new Response(JSON.stringify({ error: 'Missing object in request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const result = await stripeSync.processNext(object)

    // If more pages, re-invoke self (fire-and-forget)
    if (result.hasMore) {
      fetch(SELF_URL, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ object }),
      }).catch((err) => console.error('Failed to re-invoke worker for', object, err))
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Worker error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export interface DeployClientOptions {
  accessToken: string
  projectRef: string
}

export interface ProjectInfo {
  id: string
  name: string
  region: string
}

export class SupabaseDeployClient {
  private api: SupabaseManagementAPI
  private projectRef: string
  private projectInfo: ProjectInfo | null = null

  constructor(options: DeployClientOptions) {
    this.api = new SupabaseManagementAPI({ accessToken: options.accessToken })
    this.projectRef = options.projectRef
  }

  /**
   * Validate project access by fetching project details
   */
  async validateProject(): Promise<ProjectInfo> {
    const projects = await this.api.getProjects()
    const project = projects?.find((p) => p.id === this.projectRef)
    if (!project) {
      throw new Error(`Project ${this.projectRef} not found or access denied`)
    }
    this.projectInfo = {
      id: project.id,
      name: project.name,
      region: project.region,
    }
    return this.projectInfo
  }

  /**
   * Deploy an Edge Function
   */
  async deployFunction(name: string, code: string): Promise<void> {
    // The supabase-management-js library handles function deployment
    // We need to create the function if it doesn't exist, or update it
    const functions = await this.api.listFunctions(this.projectRef)
    const existingFunction = functions?.find((f) => f.slug === name)

    if (existingFunction) {
      await this.api.updateFunction(this.projectRef, name, {
        body: code,
        verify_jwt: false, // Stripe webhooks don't use JWT
      })
    } else {
      await this.api.createFunction(this.projectRef, {
        slug: name,
        name: name,
        body: code,
        verify_jwt: false,
      })
    }
  }

  /**
   * Set secrets for the project
   */
  async setSecrets(secrets: Record<string, string>): Promise<void> {
    const secretsArray = Object.entries(secrets).map(([name, value]) => ({
      name,
      value,
    }))
    await this.api.createSecrets(this.projectRef, secretsArray)
  }

  /**
   * Run SQL query via Management API
   */
  async runSQL(sql: string): Promise<unknown> {
    return await this.api.runQuery(this.projectRef, sql)
  }

  /**
   * Setup pg_cron job to invoke scheduler function
   */
  async setupPgCronJob(): Promise<void> {
    // Get service role key to store in vault
    const serviceRoleKey = await this.getServiceRoleKey()

    // Escape single quotes to prevent SQL injection
    // While the service role key comes from a trusted source (Supabase API),
    // it's best practice to escape any values interpolated into SQL
    const escapedServiceRoleKey = serviceRoleKey.replace(/'/g, "''")

    const sql = `
      -- Enable pg_cron and pg_net extensions if not already enabled
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;

      -- Store service role key in vault for pg_cron to use
      -- Delete existing secret if it exists, then create new one
      DELETE FROM vault.secrets WHERE name = 'stripe_sync_service_role_key';
      SELECT vault.create_secret('${escapedServiceRoleKey}', 'stripe_sync_service_role_key');

      -- Delete existing jobs if they exist
      SELECT cron.unschedule('stripe-sync-worker') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker'
      );
      SELECT cron.unschedule('stripe-sync-scheduler') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-scheduler'
      );

      -- Create job to invoke scheduler every 30 seconds
      -- This balances responsiveness with cost/resource efficiency
      SELECT cron.schedule(
        'stripe-sync-scheduler',
        '30 seconds',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.supabase.co/functions/v1/stripe-scheduler',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_service_role_key')
          )
        )
        $$
      );
    `
    await this.runSQL(sql)
  }

  /**
   * Get the webhook URL for this project
   */
  getWebhookUrl(): string {
    return `https://${this.projectRef}.supabase.co/functions/v1/stripe-webhook`
  }

  /**
   * Get the service role key for this project (needed to invoke Edge Functions)
   */
  async getServiceRoleKey(): Promise<string> {
    const apiKeys = await this.api.getProjectApiKeys(this.projectRef)
    const serviceRoleKey = apiKeys?.find((k) => k.name === 'service_role')
    if (!serviceRoleKey) {
      throw new Error('Could not find service_role API key')
    }
    return serviceRoleKey.api_key
  }

  /**
   * Invoke an Edge Function
   */
  async invokeFunction(
    name: string,
    serviceRoleKey: string
  ): Promise<{ success: boolean; error?: string }> {
    const url = `https://${this.projectRef}.supabase.co/functions/v1/${name}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
    })

    const text = await response.text()
    let data: { success?: boolean; error?: string } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      // Response wasn't JSON
      if (!response.ok) {
        return { success: false, error: text || `HTTP ${response.status}` }
      }
    }

    if (!response.ok) {
      return { success: false, error: data.error || text || `HTTP ${response.status}` }
    }
    return { success: true, ...data }
  }
}
