/**
 * WebSocket E2E Test
 * Tests WebSocket connection, event processing, and database writes
 * This test does NOT require ngrok or Stripe CLI - uses Stripe's WebSocket API directly
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgresContainer,
  queryDbCount,
  getStripeClient,
  checkEnvVars,
  waitFor,
  type PostgresContainer,
} from '../testSetup'
import { ResourceTracker } from './helpers/cleanup.js'
import { CliProcess } from './helpers/cli-process.js'

describe('WebSocket E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  let cli: CliProcess
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    cli = new CliProcess(cwd)
    await cli.start({
      DATABASE_URL: container.databaseUrl,
      STRIPE_API_KEY: process.env.STRIPE_API_KEY!,
      USE_WEBSOCKET: 'true',
      ENABLE_SIGMA: 'false',
      SKIP_BACKFILL: 'true',
    })
  }, 60000)

  afterAll(async () => {
    await cli?.stop()
    await tracker.cleanup(stripe)
    console.log('cli logs: ', cli?.getLogs())
    await pool?.end()
    await container?.stop()
  }, 30000)

  it('should connect via WebSocket (not ngrok)', async () => {
    await waitFor(() => cli.getLogs().includes('Connected to Stripe WebSocket'), 30000, {
      message: 'WebSocket did not connect within timeout',
    })
    const logs = cli.getLogs()
    expect(logs).not.toContain('ngrok tunnel')
  }, 35000)

  it('should receive and process events via WebSocket', async () => {
    const timestamp = Date.now()

    const customer = await stripe.customers.create({
      name: `Test Customer ${timestamp}`,
      email: `test-${timestamp}@example.com`,
      metadata: { test: 'wss-integration' },
    })
    tracker.trackCustomer(customer.id)

    const product = await stripe.products.create({
      name: `Test Product ${timestamp}`,
      metadata: { test: 'wss-integration' },
    })
    tracker.trackProduct(product.id)

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: 'usd',
      metadata: { test: 'wss-integration' },
    })
    tracker.trackPrice(price.id)

    await waitFor(
      () => {
        const logs = cli.getLogs()
        return (logs.match(/← /g) || []).length > 0
      },
      15000,
      { message: 'No WebSocket events received within timeout' }
    )

    expect(cli.isRunning()).toBe(true)
  }, 30000)

  it('should write events to database', async () => {
    await waitFor(
      async () => {
        const customers = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.customers')
        const products = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
        const prices = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.prices')
        return customers > 0 && products > 0 && prices > 0
      },
      15000,
      { message: 'Events not written to database within timeout' }
    )
  }, 20000)

  it('should not have WebSocket errors', async () => {
    const logs = cli.getLogs()
    expect(logs).not.toContain('WebSocket error')
  })

  it('should sync plan creation and deletion', async () => {
    const timestamp = Date.now()

    const product = await stripe.products.create({
      name: `Plan Test Product ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackProduct(product.id)

    const plan = await stripe.plans.create({
      amount: 2000,
      currency: 'usd',
      interval: 'month',
      product: product.id,
      nickname: `Test Plan ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackPlan(plan.id)

    await waitFor(
      async () =>
        (await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.plans WHERE id = $1', [plan.id])) ===
        1,
      30000,
      { message: `Plan ${plan.id} not synced to database within timeout` }
    )

    await stripe.plans.del(plan.id)

    await waitFor(
      async () =>
        (await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.plans WHERE id = $1', [plan.id])) ===
        0,
      30000,
      { message: `Plan ${plan.id} not deleted from database within timeout` }
    )
  }, 70000)

  it('should sync customer creation and soft deletion', { retry: 2, timeout: 70000 }, async () => {
    const timestamp = Date.now()

    const customer = await stripe.customers.create({
      name: `Soft Delete Test Customer ${timestamp}`,
      email: `soft-delete-${timestamp}@example.com`,
      metadata: { test: 'wss-customer-soft-delete' },
    })
    tracker.trackCustomer(customer.id)

    await waitFor(
      async () =>
        (await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.customers WHERE id = $1', [
          customer.id,
        ])) === 1,
      30000,
      { message: `Customer ${customer.id} not synced to database within timeout` }
    )

    await stripe.customers.del(customer.id)

    await waitFor(
      async () => {
        const result = await pool.query('SELECT deleted FROM stripe.customers WHERE id = $1', [
          customer.id,
        ])
        return result.rows.length === 1 && result.rows[0].deleted === true
      },
      30000,
      { message: `Customer ${customer.id} not soft-deleted within timeout` }
    )
  })
})
