import { SupabaseManagementAPI } from 'supabase-management-js'
import { readFileSync } from 'fs'
import { join } from 'path'

function getEdgeFunctionsDir(): string {
  // Works in both ESM and CJS
  // In ESM: import.meta.url is available
  // In CJS: __dirname is available
  if (typeof __dirname !== 'undefined') {
    return join(__dirname, 'edge-functions')
  }
  // ESM fallback
  const url = new URL('.', import.meta.url)
  return join(url.pathname, 'edge-functions')
}

function readEdgeFunction(name: string): string {
  return readFileSync(join(getEdgeFunctionsDir(), `${name}.ts`), 'utf-8')
}

// Read edge function source files
export const setupFunctionCode = readEdgeFunction('stripe-setup')
export const webhookFunctionCode = readEdgeFunction('stripe-webhook')
export const schedulerFunctionCode = readEdgeFunction('stripe-scheduler')
export const workerFunctionCode = readEdgeFunction('stripe-worker')

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

  constructor(options: DeployClientOptions) {
    this.api = new SupabaseManagementAPI({ accessToken: options.accessToken })
    this.projectRef = options.projectRef
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

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `${response.status}: ${text}` }
    }

    const result = await response.json()
    if (result.success === false) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }
}
