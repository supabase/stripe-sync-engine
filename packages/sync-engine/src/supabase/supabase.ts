import { SupabaseManagementAPI } from 'supabase-management-js'
import { setupFunctionCode, webhookFunctionCode, workerFunctionCode } from './edge-function-code'
import pkg from '../../package.json' with { type: 'json' }
import Stripe from 'stripe'

export interface DeployClientOptions {
  accessToken: string
  projectRef: string
  baseUrl?: string
}

export interface ProjectInfo {
  id: string
  name: string
  region: string
}

export class SupabaseDeployClient {
  private api: SupabaseManagementAPI
  private projectRef: string
  private baseUrl: string

  constructor(options: DeployClientOptions) {
    this.api = new SupabaseManagementAPI({ accessToken: options.accessToken })
    this.projectRef = options.projectRef
    this.baseUrl = options.baseUrl || process.env.SUPABASE_BASE_URL || 'supabase.co'
  }

  /**
   * Validate that the project exists and we have access
   */
  async validateProject(): Promise<ProjectInfo> {
    const projects = await this.api.getProjects()
    const project = projects?.find((p) => p.id === this.projectRef)
    if (!project) {
      throw new Error(`Project ${this.projectRef} not found or you don't have access`)
    }
    return {
      id: project.id,
      name: project.name,
      region: project.region,
    }
  }

  /**
   * Deploy an Edge Function
   */
  async deployFunction(name: string, code: string): Promise<void> {
    // Check if function exists
    const functions = await this.api.listFunctions(this.projectRef)
    const exists = functions?.some((f) => f.slug === name)

    if (exists) {
      // Update existing function
      await this.api.updateFunction(this.projectRef, name, {
        body: code,
        verify_jwt: false,
      })
    } else {
      // Create new function
      await this.api.createFunction(this.projectRef, {
        slug: name,
        name: name,
        body: code,
        verify_jwt: false,
      })
    }
  }

  /**
   * Set secrets for Edge Functions
   */
  async setSecrets(secrets: { name: string; value: string }[]): Promise<void> {
    await this.api.createSecrets(this.projectRef, secrets)
  }

  /**
   * Run SQL against the database
   */
  async runSQL(sql: string): Promise<unknown> {
    return await this.api.runQuery(this.projectRef, sql)
  }

  /**
   * Setup pg_cron job to invoke worker function
   */
  async setupPgCronJob(): Promise<void> {
    // Get service role key to store in vault
    const serviceRoleKey = await this.getServiceRoleKey()

    // Escape single quotes to prevent SQL injection
    // While the service role key comes from a trusted source (Supabase API),
    // it's best practice to escape any values interpolated into SQL
    const escapedServiceRoleKey = serviceRoleKey.replace(/'/g, "''")

    const sql = `
      -- Enable extensions
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;
      CREATE EXTENSION IF NOT EXISTS pgmq;

      -- Create pgmq queue for sync work (idempotent)
      SELECT pgmq.create('stripe_sync_work')
      WHERE NOT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'stripe_sync_work'
      );

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

      -- Create job to invoke worker every 10 seconds
      -- Worker reads from pgmq, enqueues objects if empty, and processes sync work
      SELECT cron.schedule(
        'stripe-sync-worker',
        '10 seconds',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.${this.baseUrl}/functions/v1/stripe-worker',
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
    return `https://${this.projectRef}.${this.baseUrl}/functions/v1/stripe-webhook`
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
   * Get the anon key for this project (needed for Realtime subscriptions)
   */
  async getAnonKey(): Promise<string> {
    const apiKeys = await this.api.getProjectApiKeys(this.projectRef)
    const anonKey = apiKeys?.find((k) => k.name === 'anon')
    if (!anonKey) {
      throw new Error('Could not find anon API key')
    }
    return anonKey.api_key
  }

  /**
   * Get the project URL
   */
  getProjectUrl(): string {
    return `https://${this.projectRef}.${this.baseUrl}`
  }

  /**
   * Invoke an Edge Function
   */
  async invokeFunction(
    name: string,
    serviceRoleKey: string
  ): Promise<{ success: boolean; error?: string }> {
    const url = `https://${this.projectRef}.${this.baseUrl}/functions/v1/${name}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `${response.status}: ${text}` }
    }

    const result = (await response.json()) as { success?: boolean; error?: string }
    if (result.success === false) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }

  /**
   * Check if stripe-sync is installed in the database.
   *
   * Uses the Supabase Management API to run SQL queries.
   * Uses duck typing (schema + migrations table) combined with comment validation.
   * Throws error for legacy installations to prevent accidental corruption.
   *
   * @param schema The schema name to check (defaults to 'stripe')
   * @returns true if properly installed with comment marker, false if not installed
   * @throws Error if legacy installation detected (schema exists without comment)
   */
  async isInstalled(schema = 'stripe'): Promise<boolean> {
    try {
      // Step 1: Duck typing - check if schema exists
      const schemaCheck = (await this.runSQL(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata
          WHERE schema_name = '${schema}'
        ) as schema_exists`
      )) as { rows?: { schema_exists: boolean }[] }[]

      const schemaExists = schemaCheck[0]?.rows?.[0]?.schema_exists === true

      if (!schemaExists) {
        // Schema doesn't exist - not installed
        return false
      }

      // Step 2: Check if migrations table exists (either old 'migrations' or new '_migrations')
      const migrationsCheck = (await this.runSQL(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = '${schema}' AND table_name IN ('migrations', '_migrations')
        ) as table_exists`
      )) as { rows?: { table_exists: boolean }[] }[]

      const migrationsTableExists = migrationsCheck[0]?.rows?.[0]?.table_exists === true

      if (!migrationsTableExists) {
        // Schema exists but no migrations table - incomplete/manual installation
        return false
      }

      // Step 3: Duck typing passed - now check comment
      const commentCheck = (await this.runSQL(
        `SELECT obj_description(oid, 'pg_namespace') as comment
         FROM pg_namespace
         WHERE nspname = '${schema}'`
      )) as { rows?: { comment: string | null }[] }[]

      const comment = commentCheck[0]?.rows?.[0]?.comment

      // If schema + migrations table exist but no comment, throw error (legacy installation)
      if (!comment || !comment.includes('stripe-sync')) {
        throw new Error(
          `Legacy installation detected: Schema '${schema}' and migrations table exist, but missing stripe-sync comment marker. ` +
            `This may be a legacy installation or manually created schema. ` +
            `Please contact support or manually drop the schema before proceeding.`
        )
      }

      // Check for incomplete installation (can retry)
      if (comment.includes('installation:started')) {
        return false
      }

      // Check for failed installation (requires manual intervention)
      if (comment.includes('installation:error')) {
        throw new Error(
          `Installation failed: Schema '${schema}' exists but installation encountered an error. ` +
            `Comment: ${comment}. Please uninstall and install again.`
        )
      }

      // All checks passed
      return true
    } catch (error) {
      // Re-throw our custom errors
      if (
        error instanceof Error &&
        (error.message.includes('Legacy installation detected') ||
          error.message.includes('Installation failed'))
      ) {
        throw error
      }
      // Other errors return false
      return false
    }
  }

  /**
   * Update installation progress comment on the stripe schema
   */
  async updateInstallationComment(message: string): Promise<void> {
    // Escape single quotes to prevent SQL injection
    const escapedMessage = message.replace(/'/g, "''")
    await this.runSQL(`COMMENT ON SCHEMA stripe IS '${escapedMessage}'`)
  }

  /**
   * Delete an Edge Function
   */
  async deleteFunction(name: string): Promise<void> {
    try {
      await this.api.deleteFunction(this.projectRef, name)
    } catch (err) {
      // Silently ignore if function doesn't exist
      console.warn(`Could not delete function ${name}:`, err)
    }
  }

  /**
   * Delete a secret
   */
  async deleteSecret(name: string): Promise<void> {
    try {
      await this.api.deleteSecrets(this.projectRef, [name])
    } catch (err) {
      console.warn(`Could not delete secret ${name}:`, err)
    }
  }

  /**
   * Uninstall stripe-sync from a Supabase project
   * Removes all Edge Functions, secrets, database resources, and Stripe webhooks
   */
  async uninstall(stripeSecretKey: string): Promise<void> {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-05-28.basil' })

    try {
      // Step 1: Get webhook IDs from database before dropping schema
      try {
        const webhookResult = (await this.runSQL(`
          SELECT id FROM stripe._managed_webhooks WHERE id IS NOT NULL
        `)) as { rows?: { id: string }[] }[]

        const webhookIds = webhookResult[0]?.rows?.map((r) => r.id) || []

        // Step 2: Delete Stripe webhooks via Stripe API
        for (const webhookId of webhookIds) {
          try {
            await stripe.webhookEndpoints.del(webhookId)
          } catch (err) {
            console.warn(`Could not delete Stripe webhook ${webhookId}:`, err)
          }
        }
      } catch (err) {
        console.warn('Could not query/delete webhooks:', err)
      }

      // Step 3: Delete Edge Functions
      await this.deleteFunction('stripe-setup')
      await this.deleteFunction('stripe-webhook')
      await this.deleteFunction('stripe-worker')

      // Step 4: Delete Supabase secrets
      await this.deleteSecret('STRIPE_SECRET_KEY')

      // Step 5: Unschedule pg_cron job
      try {
        await this.runSQL(`
          SELECT cron.unschedule('stripe-sync-worker')
          WHERE EXISTS (
            SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker'
          )
        `)
      } catch (err) {
        console.warn('Could not unschedule pg_cron job:', err)
      }

      // Step 6: Delete vault secret
      try {
        await this.runSQL(`
          DELETE FROM vault.secrets
          WHERE name = 'stripe_sync_service_role_key'
        `)
      } catch (err) {
        console.warn('Could not delete vault secret:', err)
      }

      // Step 7: Drop schema (cascades to all tables, views, indexes, etc.)
      await this.runSQL(`DROP SCHEMA IF EXISTS stripe CASCADE`)
    } catch (error) {
      throw new Error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function install(params: {
  supabaseAccessToken: string
  supabaseProjectRef: string
  stripeKey: string
}): Promise<void> {
  const { supabaseAccessToken, supabaseProjectRef, stripeKey } = params

  const trimmedStripeKey = stripeKey.trim()
  if (!trimmedStripeKey.startsWith('sk_') && !trimmedStripeKey.startsWith('rk_')) {
    throw new Error('Stripe key should start with "sk_" or "rk_"')
  }

  const client = new SupabaseDeployClient({
    accessToken: supabaseAccessToken,
    projectRef: supabaseProjectRef,
  })

  try {
    // Validate project
    await client.validateProject()

    // Create schema if it doesn't exist (before we can comment on it)
    await client.runSQL(`CREATE SCHEMA IF NOT EXISTS stripe`)

    // Signal installation started
    await client.updateInstallationComment(`stripe-sync v${pkg.version} installation:started`)

    // Deploy Edge Functions
    await client.deployFunction('stripe-setup', setupFunctionCode)
    await client.deployFunction('stripe-webhook', webhookFunctionCode)
    await client.deployFunction('stripe-worker', workerFunctionCode)

    // Set secrets
    await client.setSecrets([{ name: 'STRIPE_SECRET_KEY', value: trimmedStripeKey }])

    // Run setup (migrations + webhook creation)
    const serviceRoleKey = await client.getServiceRoleKey()
    const setupResult = await client.invokeFunction('stripe-setup', serviceRoleKey)

    if (!setupResult.success) {
      throw new Error(`Setup failed: ${setupResult.error}`)
    }

    // Setup pg_cron
    try {
      await client.setupPgCronJob()
    } catch {
      // pg_cron may not be available
    }

    // Set final version comment
    await client.updateInstallationComment(`stripe-sync v${pkg.version} installed`)
  } catch (error) {
    await client.updateInstallationComment(
      `stripe-sync v${pkg.version} installation:error - ${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  }
}

export async function uninstall(params: {
  supabaseAccessToken: string
  supabaseProjectRef: string
  stripeKey: string
}): Promise<void> {
  const { supabaseAccessToken, supabaseProjectRef, stripeKey } = params

  const trimmedStripeKey = stripeKey.trim()
  if (!trimmedStripeKey.startsWith('sk_') && !trimmedStripeKey.startsWith('rk_')) {
    throw new Error('Stripe key should start with "sk_" or "rk_"')
  }

  const client = new SupabaseDeployClient({
    accessToken: supabaseAccessToken,
    projectRef: supabaseProjectRef,
  })

  await client.uninstall(trimmedStripeKey)
}
