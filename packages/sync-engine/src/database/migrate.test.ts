import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from 'pg'
import { runMigrations } from './migrate'

describe('runMigrations', () => {
  let client: Client
  const testSchema = 'stripe'
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl })
    await client.connect()

    // Clean up test schema before each test
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`)
    await client.query(`CREATE SCHEMA "${testSchema}"`)
  })

  afterEach(async () => {
    // Clean up test schema after each test
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`)
    await client.end()
  })

  it('should drop and recreate schema when migrations table is empty', async () => {
    // Setup: Create empty migrations table
    await client.query(`
      CREATE TABLE "${testSchema}"."_migrations" (
        id integer PRIMARY KEY,
        name varchar(100) UNIQUE NOT NULL,
        hash varchar(40) NOT NULL,
        executed_at timestamp DEFAULT current_timestamp
      )
    `)

    // Create a dummy table that should be removed during cleanup
    await client.query(`CREATE TABLE "${testSchema}".dummy_table (id integer)`)

    // Verify setup
    let result = await client.query(`
      SELECT COUNT(*) as count FROM "${testSchema}"."_migrations"
    `)
    expect(result.rows[0].count).toBe('0')

    result = await client.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'dummy_table'
      )
    `,
      [testSchema]
    )
    expect(result.rows[0].exists).toBe(true)

    // Execute: Run migrations with empty table
    await runMigrations({
      databaseUrl,
      schema: testSchema,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })

    // Verify: Schema was recreated (dummy table should be gone)
    result = await client.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'dummy_table'
      )
    `,
      [testSchema]
    )
    expect(result.rows[0].exists).toBe(false)

    // Verify: Migrations ran successfully (migrations table should have entries)
    result = await client.query(`
      SELECT COUNT(*) as count FROM "${testSchema}"."_migrations"
    `)
    expect(parseInt(result.rows[0].count)).toBeGreaterThan(0)
  })

  it('should run migrations normally when table has existing migrations', async () => {
    // Setup: Run migrations once to populate the table
    await runMigrations({
      databaseUrl,
      schema: testSchema,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })

    // Get initial migration count
    let result = await client.query(`
      SELECT COUNT(*) as count FROM "${testSchema}"."_migrations"
    `)
    const initialCount = parseInt(result.rows[0].count)
    expect(initialCount).toBeGreaterThan(0)

    // Execute: Run migrations again
    await runMigrations({
      databaseUrl,
      schema: testSchema,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })

    // Verify: Migration count should be the same (idempotent)
    result = await client.query(`
      SELECT COUNT(*) as count FROM "${testSchema}"."_migrations"
    `)
    const finalCount = parseInt(result.rows[0].count)
    expect(finalCount).toBe(initialCount)
  })

  it('should create migrations table and run when it does not exist', async () => {
    // Setup: Schema already exists from beforeEach, but no migrations table

    // Verify setup: migrations table doesn't exist
    let result = await client.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = '_migrations'
      )
    `,
      [testSchema]
    )
    expect(result.rows[0].exists).toBe(false)

    // Execute: Run migrations
    await runMigrations({
      databaseUrl,
      schema: testSchema,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })

    // Verify: Migrations table was created
    result = await client.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = '_migrations'
      )
    `,
      [testSchema]
    )
    expect(result.rows[0].exists).toBe(true)

    // Verify: Migrations ran successfully
    result = await client.query(`
      SELECT COUNT(*) as count FROM "${testSchema}"."_migrations"
    `)
    expect(parseInt(result.rows[0].count)).toBeGreaterThan(0)
  })

  it('should throw error when migrations fail', async () => {
    // Setup: Create a conflicting table that will cause migration to fail
    // Schema already exists from beforeEach

    // Create a table with the same name as one of the migrations but with wrong schema
    // This should cause a migration error
    await client.query(`
      CREATE TABLE "${testSchema}".customers (
        wrong_column text
      )
    `)

    // Execute and Verify: Should throw error
    await expect(async () => {
      await runMigrations({
        databaseUrl,
        schema: testSchema,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      })
    }).rejects.toThrow()
  })
})
