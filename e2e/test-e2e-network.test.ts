import { describe, expect, it } from 'vitest'
import createFetchClient from 'openapi-fetch'
import type { paths } from '../apps/service/src/__generated__/openapi.js'
import { BUNDLED_API_VERSION } from '../packages/openapi/src/versions.js'
import {
  SERVICE_URL,
  pauseComposeService,
  pauseDockerContainer,
  pollUntil,
  startServiceHarness,
  unpauseComposeService,
  unpauseDockerContainer,
  type ServiceHarness,
} from './test-server-harness.js'

type PipelineRecord = { id: string; status: string; desired_status: string }

const api = () => createFetchClient<paths>({ baseUrl: SERVICE_URL })

let schemaCounter = 0

function uniqueSchema(prefix: string): string {
  return `${prefix}_${Date.now()}_${schemaCounter++}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function countRows(harness: ServiceHarness, schema: string): Promise<number> {
  try {
    const { rows } = await harness.destPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${schema}"."customers"`
    )
    return rows[0]?.n ?? 0
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return 0
    throw err
  }
}

async function getPipeline(id: string): Promise<PipelineRecord | null> {
  const { data } = await api().GET('/pipelines/{id}', {
    params: { path: { id } },
  })
  return (data as PipelineRecord | undefined) ?? null
}

async function createCustomersPipeline(
  harness: ServiceHarness,
  schema: string,
  sourceOverrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await api().POST('/pipelines', {
    body: {
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_fake',
          api_version: BUNDLED_API_VERSION,
          base_url: harness.testServerContainerUrl(),
          rate_limit: 1000,
          ...sourceOverrides,
        },
      },
      destination: {
        type: 'postgres',
        postgres: {
          connection_string: harness.destPgContainerUrl(),
          schema,
        },
      },
      streams: [{ name: 'customers' }],
    } as never,
  })
  expect(error).toBeUndefined()
  expect(data?.id).toMatch(/^pipe_/)
  return data!.id
}

async function deletePipeline(id: string | undefined): Promise<void> {
  if (!id) return
  await api()
    .DELETE('/pipelines/{id}', {
      params: { path: { id } },
    })
    .catch(() => undefined)
}

async function cleanupHarness(
  harness: ServiceHarness | undefined,
  pipelineId: string | undefined,
  schema: string
): Promise<void> {
  await deletePipeline(pipelineId)
  await harness?.destPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await harness?.close().catch(() => {})
}

async function waitForPartialRows(
  harness: ServiceHarness,
  schema: string,
  expectedCount: number,
  minimumRows = 100
): Promise<number> {
  await pollUntil(
    async () => {
      const count = await countRows(harness, schema)
      return count >= minimumRows && count < expectedCount
    },
    { timeout: 60_000, interval: 1000 }
  )
  return countRows(harness, schema)
}

async function waitForCompletionWithoutFalseReady(opts: {
  harness: ServiceHarness
  pipelineId: string
  schema: string
  expectedCount: number
  timeout?: number
}): Promise<void> {
  const deadline = Date.now() + (opts.timeout ?? 90_000)
  while (Date.now() < deadline) {
    const [pipeline, rows] = await Promise.all([
      getPipeline(opts.pipelineId),
      countRows(opts.harness, opts.schema),
    ])

    if (pipeline?.status === 'ready' && rows < opts.expectedCount) {
      throw new Error(
        `pipeline ${opts.pipelineId} reached ready with only ${rows}/${opts.expectedCount} rows`
      )
    }
    if (rows === opts.expectedCount) {
      return
    }

    await sleep(1000)
  }

  const finalRows = await countRows(opts.harness, opts.schema)
  const finalPipeline = await getPipeline(opts.pipelineId)
  throw new Error(
    `pipeline ${opts.pipelineId} did not finish: status=${finalPipeline?.status ?? 'missing'} rows=${finalRows}/${opts.expectedCount}`
  )
}

async function waitForStalledIncompletePipeline(opts: {
  harness: ServiceHarness
  pipelineId: string
  schema: string
  expectedCount: number
  stableForMs?: number
  timeout?: number
}): Promise<{ rows: number; status: string | null }> {
  const stableForMs = opts.stableForMs ?? 8000
  const deadline = Date.now() + (opts.timeout ?? 45_000)
  let lastRows = -1
  let lastChangeAt = Date.now()

  while (Date.now() < deadline) {
    const [pipeline, rows] = await Promise.all([
      getPipeline(opts.pipelineId),
      countRows(opts.harness, opts.schema),
    ])

    if (pipeline?.status === 'ready' && rows < opts.expectedCount) {
      throw new Error(
        `pipeline ${opts.pipelineId} reached ready with only ${rows}/${opts.expectedCount} rows after interruption`
      )
    }
    if (rows === opts.expectedCount) {
      throw new Error(`pipeline ${opts.pipelineId} unexpectedly completed after source shutdown`)
    }

    if (rows !== lastRows) {
      lastRows = rows
      lastChangeAt = Date.now()
    } else if (Date.now() - lastChangeAt >= stableForMs) {
      return { rows, status: pipeline?.status ?? null }
    }

    await sleep(1000)
  }

  const finalRows = await countRows(opts.harness, opts.schema)
  const finalPipeline = await getPipeline(opts.pipelineId)
  throw new Error(
    `pipeline ${opts.pipelineId} never settled after interruption: status=${finalPipeline?.status ?? 'missing'} rows=${finalRows}/${opts.expectedCount}`
  )
}

describe('network interruption e2e via Docker service', () => {
  it('recovers from a transient list-server 500 without reporting ready early', async () => {
    const schema = uniqueSchema('e2e_network_http_500')
    let harness: ServiceHarness | undefined
    let pipelineId: string | undefined

    try {
      harness = await startServiceHarness({
        customerCount: 250,
        listServer: {
          failures: [
            {
              path: '/v1/customers',
              status: 500,
              after: 1,
              times: 1,
              stripeError: {
                type: 'api_error',
                message: 'Injected transient customers page failure',
              },
            },
          ],
        },
      })

      pipelineId = await createCustomersPipeline(harness, schema, {
        rate_limit: 1000,
      })

      await waitForCompletionWithoutFalseReady({
        harness,
        pipelineId,
        schema,
        expectedCount: harness.expectedIds.length,
        timeout: 120_000,
      })

      const pipeline = await getPipeline(pipelineId)
      expect(pipeline?.status).toBe('ready')
      expect(await countRows(harness, schema)).toBe(harness.expectedIds.length)
    } finally {
      await cleanupHarness(harness, pipelineId, schema)
    }
  }, 180_000)

  it('does not report ready after the source server disappears mid-backfill', async () => {
    const schema = uniqueSchema('e2e_network_source_down')
    let harness: ServiceHarness | undefined
    let pipelineId: string | undefined

    try {
      harness = await startServiceHarness({ customerCount: 5000 })
      pipelineId = await createCustomersPipeline(harness, schema)

      await waitForPartialRows(harness, schema, harness.expectedIds.length)
      await harness.testServer.close()

      const stalled = await waitForStalledIncompletePipeline({
        harness,
        pipelineId,
        schema,
        expectedCount: harness.expectedIds.length,
      })

      expect(stalled.rows).toBeLessThan(harness.expectedIds.length)
      expect(stalled.status).not.toBe('ready')
    } finally {
      await cleanupHarness(harness, pipelineId, schema)
    }
  }, 180_000)

  it('resumes after destination Postgres is paused mid-sync', async () => {
    const schema = uniqueSchema('e2e_network_dest_pg_pause')
    let harness: ServiceHarness | undefined
    let pipelineId: string | undefined

    try {
      harness = await startServiceHarness({ customerCount: 5000 })
      pipelineId = await createCustomersPipeline(harness, schema)

      await waitForPartialRows(harness, schema, harness.expectedIds.length)

      pauseDockerContainer(harness.destDocker.containerId)
      try {
        await sleep(4000)
        const pipeline = await getPipeline(pipelineId)
        expect(pipeline?.status).not.toBe('ready')
      } finally {
        unpauseDockerContainer(harness.destDocker.containerId)
      }

      await waitForCompletionWithoutFalseReady({
        harness,
        pipelineId,
        schema,
        expectedCount: harness.expectedIds.length,
        timeout: 120_000,
      })
    } finally {
      await cleanupHarness(harness, pipelineId, schema)
    }
  }, 180_000)

  it('resumes after the engine container is paused mid-sync', async () => {
    const schema = uniqueSchema('e2e_network_engine_pause')
    let harness: ServiceHarness | undefined
    let pipelineId: string | undefined

    try {
      harness = await startServiceHarness({ customerCount: 5000 })
      pipelineId = await createCustomersPipeline(harness, schema)

      const rowsBeforePause = await waitForPartialRows(harness, schema, harness.expectedIds.length)

      pauseComposeService('engine')
      try {
        await sleep(4000)
        const rowsDuringPause = await countRows(harness, schema)
        expect(rowsDuringPause).toBe(rowsBeforePause)
      } finally {
        unpauseComposeService('engine')
      }

      await waitForCompletionWithoutFalseReady({
        harness,
        pipelineId,
        schema,
        expectedCount: harness.expectedIds.length,
        timeout: 120_000,
      })
    } finally {
      await cleanupHarness(harness, pipelineId, schema)
    }
  }, 180_000)
})
