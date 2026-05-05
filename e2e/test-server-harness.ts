import { execSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import {
  applyCreatedTimestampRange,
  createStripeListServer,
  ensureObjectTable,
  ensureSchema,
  startDockerPostgres18,
  upsertObjects,
  type DockerPostgres18Handle,
  type StripeListServer,
  type StripeListServerOptions,
} from '@stripe/sync-test-utils'
import {
  BUNDLED_API_VERSION,
  generateObjectsFromSchema,
  resolveOpenApiSpec,
} from '@stripe/sync-openapi'

export const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:4020'
export const ENGINE_URL = process.env.ENGINE_URL ?? 'http://localhost:4010'
export const CONTAINER_HOST = process.env.CONTAINER_HOST ?? 'host.docker.internal'
export const SKIP_SETUP = process.env.SKIP_SETUP === '1'
export const REPO_ROOT = path.resolve(import.meta.dirname, '..')
export const COMPOSE_CMD = `docker compose -f compose.yml -f compose.dev.yml -f e2e/compose.e2e.yml`

export const CUSTOMER_COUNT = 10_000
export const SEED_BATCH = 1000
export const SOURCE_SCHEMA = 'stripe'

export function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

export const RANGE_START = utc('2021-04-03')
export const RANGE_END = utc('2026-04-02')

export type StartServiceHarnessOptions = {
  customerCount?: number
  seedBatchSize?: number
  listServer?: Partial<Omit<StripeListServerOptions, 'postgresUrl' | 'host' | 'port'>>
}

export async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 300_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

async function isServiceHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function isEngineHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureDockerStack(): Promise<void> {
  console.log('  Starting Docker stack...')
  execSync(`${COMPOSE_CMD} up --build -d temporal engine service worker`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  console.log('  Waiting for service health...')
  await pollUntil(isServiceHealthy, { timeout: 180_000 })
}

export async function ensureServiceStack(): Promise<void> {
  if (!SKIP_SETUP) {
    await ensureDockerStack()
  }
  await pollUntil(isServiceHealthy, { timeout: 60_000 })
}

export async function ensureEngineStack(): Promise<void> {
  if (!SKIP_SETUP) {
    await ensureDockerStack()
  }
  await pollUntil(isEngineHealthy, { timeout: 60_000 })
}

function pool(connectionString: string): pg.Pool {
  const next = new pg.Pool({ connectionString })
  next.on('error', () => {})
  return next
}

function dockerOutput(command: string): string {
  return execSync(command, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

export function composeContainerId(serviceName: string): string {
  const containerId = dockerOutput(`${COMPOSE_CMD} ps -q ${serviceName}`)
  if (!containerId) {
    throw new Error(`No running container found for compose service "${serviceName}"`)
  }
  return containerId
}

export function pauseDockerContainer(containerId: string): void {
  execSync(`docker pause ${containerId}`, { cwd: REPO_ROOT, stdio: 'pipe' })
}

export function unpauseDockerContainer(containerId: string): void {
  execSync(`docker unpause ${containerId}`, { cwd: REPO_ROOT, stdio: 'pipe' })
}

export function pauseComposeService(serviceName: string): string {
  const containerId = composeContainerId(serviceName)
  pauseDockerContainer(containerId)
  return containerId
}

export function unpauseComposeService(serviceName: string): string {
  const containerId = composeContainerId(serviceName)
  unpauseDockerContainer(containerId)
  return containerId
}

async function loadBundledSpec() {
  return (await resolveOpenApiSpec({ apiVersion: BUNDLED_API_VERSION }, fetch)).spec
}

function generateTemplate(
  spec: import('@stripe/sync-openapi').OpenApiSpec,
  schemaName: string,
  tableName?: string
): Record<string, unknown> {
  return generateObjectsFromSchema(spec, schemaName, 1, { tableName })[0]
}

export type ServiceHarness = {
  sourceDocker: DockerPostgres18Handle
  destDocker: DockerPostgres18Handle
  destPool: pg.Pool
  testServer: StripeListServer
  expectedIds: string[]
  testServerContainerUrl: () => string
  destPgContainerUrl: () => string
  close: () => Promise<void>
}

export async function startServiceHarness(
  options: StartServiceHarnessOptions = {}
): Promise<ServiceHarness> {
  await ensureServiceStack()

  const [sourceDocker, destDocker, spec] = await Promise.all([
    startDockerPostgres18(),
    startDockerPostgres18(),
    loadBundledSpec(),
  ])
  const sourcePool = pool(sourceDocker.connectionString)
  const destPool = pool(destDocker.connectionString)

  await ensureSchema(sourcePool, SOURCE_SCHEMA)
  await ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'customer')

  const count = options.customerCount ?? CUSTOMER_COUNT
  const batchSize = options.seedBatchSize ?? SEED_BATCH
  const template = generateTemplate(spec, 'customer', 'customer')
  const objects = applyCreatedTimestampRange(
    Array.from({ length: count }, (_, i) => ({
      ...template,
      id: `cus_test_${String(i).padStart(5, '0')}`,
      created: 0,
    })),
    { startUnix: RANGE_START, endUnix: RANGE_END }
  )
  for (let i = 0; i < objects.length; i += batchSize) {
    await upsertObjects(sourcePool, SOURCE_SCHEMA, 'customer', objects.slice(i, i + batchSize))
  }
  const expectedIds = objects.map((o) => o.id as string)

  const testServer = await createStripeListServer({
    ...options.listServer,
    postgresUrl: sourceDocker.connectionString,
    host: '0.0.0.0',
    port: 0,
    accountCreated: options.listServer?.accountCreated ?? RANGE_START,
  })

  console.log(`  Source PG:       ${sourceDocker.connectionString}`)
  console.log(`  Dest PG:         ${destDocker.connectionString}`)
  console.log(`  Test server:     http://0.0.0.0:${testServer.port}`)
  console.log(`  Service API:     ${SERVICE_URL}`)
  console.log(`  Container host:  ${CONTAINER_HOST}`)

  return {
    sourceDocker,
    destDocker,
    destPool,
    testServer,
    expectedIds,
    testServerContainerUrl: () => `http://${CONTAINER_HOST}:${testServer.port}`,
    destPgContainerUrl: () => destDocker.connectionString.replace('localhost', CONTAINER_HOST),
    close: async () => {
      await testServer.close().catch(() => {})
      await sourcePool.end().catch(() => {})
      await destPool.end().catch(() => {})
      await destDocker.stop()
      await sourceDocker.stop()
    },
  }
}

export type EngineHarness = {
  sourceDocker: DockerPostgres18Handle
  destDocker: DockerPostgres18Handle
  testServer: StripeListServer
  sourcePool: pg.Pool
  destPool: pg.Pool
  customerTemplate: Record<string, unknown>
  productTemplate: Record<string, unknown>
  hostTestServerUrl: () => string
  testServerContainerUrl: () => string
  destPgContainerUrl: () => string
  close: () => Promise<void>
}

export async function startEngineHarness(): Promise<EngineHarness> {
  await ensureEngineStack()

  const [sourceDocker, destDocker, spec] = await Promise.all([
    startDockerPostgres18(),
    startDockerPostgres18(),
    loadBundledSpec(),
  ])
  const customerTemplate = generateTemplate(spec, 'customer', 'customer')
  const productTemplate = generateTemplate(spec, 'product', 'product')

  const sourcePool = pool(sourceDocker.connectionString)
  const destPool = pool(destDocker.connectionString)

  await ensureSchema(sourcePool, SOURCE_SCHEMA)
  await Promise.all([
    ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'customer'),
    ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'product'),
  ])

  const testServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    host: '0.0.0.0',
    port: 0,
    accountCreated: RANGE_START,
  })

  return {
    sourceDocker,
    destDocker,
    testServer,
    sourcePool,
    destPool,
    customerTemplate,
    productTemplate,
    hostTestServerUrl: () => `http://127.0.0.1:${testServer.port}`,
    testServerContainerUrl: () => `http://${CONTAINER_HOST}:${testServer.port}`,
    destPgContainerUrl: () => destDocker.connectionString.replace('localhost', CONTAINER_HOST),
    close: async () => {
      await testServer.close().catch(() => {})
      await sourcePool.end().catch(() => {})
      await destPool.end().catch(() => {})
      await destDocker.stop()
      await sourceDocker.stop()
    },
  }
}
