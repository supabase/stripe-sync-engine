import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SupabaseSetupClient } from './supabase'

describe('SupabaseDeployClient', () => {
  const mockAccessToken = 'test-access-token'
  const mockProjectRef = 'abcdefghijklmnop'

  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original env var
    originalEnv = process.env.SUPABASE_BASE_URL
    // Clear env var before each test
    delete process.env.SUPABASE_BASE_URL
  })

  afterEach(() => {
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.SUPABASE_BASE_URL = originalEnv
    } else {
      delete process.env.SUPABASE_BASE_URL
    }
  })

  describe('Base URL Configuration', () => {
    it('should use default base URL when no option or env var is provided', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-webhook`
      )
    })

    it('should use environment variable when provided', () => {
      process.env.SUPABASE_BASE_URL = 'custom-domain.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.custom-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.custom-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should prioritize option over environment variable', () => {
      process.env.SUPABASE_BASE_URL = 'env-domain.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'option-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.option-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.option-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should use custom base URL from options', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'my-custom.supabase.co',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-custom.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.my-custom.supabase.co/functions/v1/stripe-webhook`
      )
    })
  })

  describe('URL Generation Methods', () => {
    it('should generate correct project URL with custom base URL', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.test-domain.com`)
    })

    it('should generate correct webhook URL with custom base URL', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should generate correct function invocation URL with custom base URL', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      // Mock fetch to intercept the URL being called
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      })
      global.fetch = mockFetch

      await client.invokeFunction('test-function', 'test-service-role-key')

      expect(mockFetch).toHaveBeenCalledWith(
        `https://${mockProjectRef}.test-domain.com/functions/v1/test-function`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-service-role-key',
          }),
        })
      )

      vi.restoreAllMocks()
    })
  })

  describe('setupPgCronJob with custom base URL', () => {
    it('should include custom base URL in pg_cron SQL', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob()

      // Verify runQuery was called
      expect(mockRunQuery).toHaveBeenCalled()

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it contains the custom base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-worker`
      )
    })

    it('should use default base URL in pg_cron SQL when not customized', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob()

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it contains the default base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-worker`
      )
    })

    it('should use interval format for sub-minute intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob(30)

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it uses interval format for seconds
      expect(executedSQL).toContain("'30 seconds'")
    })

    it('should use cron format for minute intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob(120)

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it uses cron format for 2 minutes
      expect(executedSQL).toContain("'*/2 * * * *'")
    })

    it('should use default interval of 60 seconds (1 minute) when not specified', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob()

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it uses cron format for 1 minute
      expect(executedSQL).toContain("'*/1 * * * *'")
    })

    it('should reject invalid worker intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys

      // Test various invalid inputs
      await expect(client.setupPgCronJob(0)).rejects.toThrow('Invalid interval')
      await expect(client.setupPgCronJob(-1)).rejects.toThrow('Invalid interval')
      await expect(client.setupPgCronJob(1.5)).rejects.toThrow('Invalid interval')

      // Test intervals that aren't multiples of 60 (when >= 60)
      await expect(client.setupPgCronJob(90)).rejects.toThrow(
        'Must be either 1-59 seconds or a multiple of 60'
      )

      // Test intervals >= 1 hour
      await expect(client.setupPgCronJob(3600)).rejects.toThrow(
        'Intervals >= 3600 seconds (1 hour) are not supported'
      )
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty string base URL option by using env var', () => {
      process.env.SUPABASE_BASE_URL = 'env-fallback.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: '',
      })

      // Empty string is falsy, so it should fall back to env var
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.env-fallback.com`)
    })

    it('should handle empty string base URL option and env var by using default', () => {
      process.env.SUPABASE_BASE_URL = ''

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: '',
      })

      // Both are empty/falsy, should use default
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
    })

    it('should work with base URLs containing protocols (should strip them in construction)', () => {
      // Note: This test documents current behavior - base URL should NOT include protocol
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'my-domain.com',
      })

      // The URL construction adds https://, so base URL should not include it
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-domain.com`)
      expect(client.getProjectUrl()).not.toContain('https://https://')
    })

    it('should work with base URLs containing subdomains', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'api.custom-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.api.custom-domain.com`)
    })
  })

  describe('isInstalled()', () => {
    it('should return false when schema does not exist', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema doesn't exist
      const mockRunSQL = vi.fn().mockResolvedValueOnce([{ rows: [{ schema_exists: false }] }])
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should return false when schema exists but no migrations table', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema exists, but migrations table doesn't
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: false }] }]) // migrations table doesn't exist
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should throw error when schema and migrations table exist but no comment', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema exists, migrations table exists, but no comment
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([{ rows: [{ comment: null }] }]) // no comment
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      await expect(client.isInstalled()).rejects.toThrow(/Legacy installation detected/)
    })

    it('should throw error when schema and migrations table exist but comment missing stripe-sync', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema exists, migrations table exists, but wrong comment
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([{ rows: [{ comment: 'some other tool' }] }]) // wrong comment
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      await expect(client.isInstalled()).rejects.toThrow(/Legacy installation detected/)
    })

    it('should return false when installation is in progress (installation:started)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return in-progress installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([{ rows: [{ comment: 'stripe-sync v1.0.0 installation:started' }] }]) // in progress
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should throw error when installation has failed (installation:error)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return failed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([
          {
            rows: [{ comment: 'stripe-sync v1.0.0 installation:error - Something went wrong' }],
          },
        ]) // failed
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      try {
        await client.isInstalled()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Installation failed')
        expect((error as Error).message).toContain('uninstall and install again')
      }
    })

    it('should return true when installation is complete', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return completed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([{ rows: [{ comment: 'stripe-sync v1.0.0 installed' }] }]) // installed
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(true)
    })

    it('should work with custom schema name', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return completed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ rows: [{ schema_exists: true }] }]) // schema exists
        .mockResolvedValueOnce([{ rows: [{ table_exists: true }] }]) // migrations table exists
        .mockResolvedValueOnce([{ rows: [{ comment: 'stripe-sync v1.0.0 installed' }] }]) // installed
      // @ts-expect-error - accessing private method for testing
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled('custom_schema')

      expect(installed).toBe(true)
      // Verify the SQL queries included the custom schema name
      expect(mockRunSQL).toHaveBeenCalledWith(expect.stringContaining('custom_schema'))
    })
  })
})
