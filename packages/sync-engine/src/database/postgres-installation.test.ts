import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgresClient } from './postgres'
import { runMigrations } from './migrate'
import pg from 'pg'

describe('PostgresClient.isInstalled()', () => {
  let client: pg.Client
  let postgresClient: PostgresClient
  const testSchema = 'stripe_test_install'
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()

    postgresClient = new PostgresClient({
      schema: testSchema,
      poolConfig: {
        connectionString: databaseUrl,
        max: 1,
      },
    })
  })

  afterAll(async () => {
    // Cleanup test schema
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`)
    await client.end()
    await postgresClient.pool.end()
  })

  beforeEach(async () => {
    // Clean up test schema before each test
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`)
  })

  it('returns false when schema does not exist', async () => {
    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(false)
  })

  it('returns false when schema exists but migrations table does not exist', async () => {
    // Create schema but no migrations table
    await client.query(`CREATE SCHEMA "${testSchema}"`)

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(false)
  })

  it('throws error when schema and old migrations table exist but comment is missing', async () => {
    // Create schema with old 'migrations' table but no comment
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)

    await expect(postgresClient.isInstalled()).rejects.toThrow(/Legacy installation detected/)
  })

  it('throws error when schema and new _migrations table exist but comment is missing', async () => {
    // Create schema with new '_migrations' table but no comment
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."_migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)

    await expect(postgresClient.isInstalled()).rejects.toThrow(/Legacy installation detected/)
  })

  it('throws error when schema and migrations table exist with wrong comment', async () => {
    // Create schema with _migrations table and wrong comment
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."_migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    await client.query(`COMMENT ON SCHEMA "${testSchema}" IS 'some other tool'`)

    await expect(postgresClient.isInstalled()).rejects.toThrow(/Legacy installation detected/)
  })

  it('returns true when schema, old migrations table, and comment all exist', async () => {
    // Create schema with old 'migrations' table and proper comment
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    await client.query(`COMMENT ON SCHEMA "${testSchema}" IS 'stripe-sync v1.0.0 installed'`)

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(true)
  })

  it('returns true when schema, new _migrations table, and comment all exist', async () => {
    // Create schema with new '_migrations' table and proper comment
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."_migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    await client.query(`COMMENT ON SCHEMA "${testSchema}" IS 'stripe-sync v1.0.0 installed'`)

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(true)
  })

  it('returns true when both migrations tables exist with comment', async () => {
    // Create schema with both old and new migrations tables and proper comment
    // This tests the migration transition period
    await client.query(`CREATE SCHEMA "${testSchema}"`)
    await client.query(`
      CREATE TABLE "${testSchema}"."migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    await client.query(`
      CREATE TABLE "${testSchema}"."_migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    await client.query(`COMMENT ON SCHEMA "${testSchema}" IS 'stripe-sync v1.0.0 installed'`)

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(true)
  })
})

describe.sequential('runMigrations() integration with isInstalled()', () => {
  let client: pg.Client | undefined
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
  })

  afterAll(async () => {
    // Cleanup stripe schema (runMigrations uses 'stripe' schema)
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS "stripe" CASCADE`)
        await client.end()
      } catch (err) {
        console.warn('Cleanup failed:', err)
      }
    }
  })

  beforeEach(async () => {
    // Clean up stripe schema before each test
    await client.query(`DROP SCHEMA IF EXISTS "stripe" CASCADE`)
  })

  it('throws error when runMigrations detects legacy installation', async () => {
    // Create a legacy installation (stripe schema + _migrations table without comment)
    await client.query(`CREATE SCHEMA "stripe"`)
    await client.query(`
      CREATE TABLE "stripe"."_migrations" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // runMigrations should throw when it detects the legacy installation
    await expect(
      runMigrations({
        databaseUrl,
      })
    ).rejects.toThrow(/Legacy installation detected/)
  })

  it('succeeds and sets comment for new installations', async () => {
    // Don't create anything - completely fresh installation
    // runMigrations should succeed and set the comment
    await runMigrations({ databaseUrl })

    // Verify installation is now complete with comment
    const postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig: { connectionString: databaseUrl, max: 1 },
    })

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(true)

    // Verify comment was set
    const result = await client.query(
      `SELECT obj_description(oid, 'pg_namespace') as comment
       FROM pg_namespace WHERE nspname = 'stripe'`
    )
    expect(result.rows[0].comment).toMatch(/stripe-sync/)

    await postgresClient.pool.end()
  })

  it('succeeds for existing proper installations', async () => {
    // Create a proper installation with comment first
    await runMigrations({ databaseUrl })

    // Run migrations again - should succeed idempotently
    await expect(runMigrations({ databaseUrl })).resolves.not.toThrow()

    // Verify still properly installed
    const postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig: { connectionString: databaseUrl, max: 1 },
    })

    const installed = await postgresClient.isInstalled()
    expect(installed).toBe(true)

    await postgresClient.pool.end()
  })
})
