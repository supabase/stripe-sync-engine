import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyCreatedTimestampRange,
  ensureObjectTable,
  quoteIdentifier,
  upsertObjects,
} from '@stripe/sync-test-utils'
import {
  createRemoteEngine,
  type Message,
  type PipelineConfig,
  type SourceState,
  type SyncOutput,
} from '@stripe/sync-engine'
import { type StreamState } from '@stripe/sync-source-stripe'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'
import {
  ENGINE_URL,
  RANGE_END,
  RANGE_START,
  SEED_BATCH,
  SOURCE_SCHEMA,
  startEngineHarness,
  type EngineHarness,
} from './test-server-harness.js'

describe('test-server sync via Docker engine', () => {
  const engine = createRemoteEngine(ENGINE_URL)
  const createdSchemas: string[] = []
  let harness: EngineHarness
  let schemaCounter = 0

  function uniqueSchema(prefix: string): string {
    const name = `${prefix}_${Date.now()}_${schemaCounter++}`
    createdSchemas.push(name)
    return name
  }

  function makeCustomer(id: string, created: number): Record<string, unknown> {
    return { ...harness.customerTemplate, id, created }
  }

  function makeProduct(id: string, created: number): Record<string, unknown> {
    return { ...harness.productTemplate, id, created }
  }

  function toIso(unix: number): string {
    return new Date(unix * 1000).toISOString()
  }

  function buildSegmentRanges(numSegments: number): Array<{ gte: number; lt: number }> {
    const span = RANGE_END - RANGE_START
    const segSize = Math.max(1, Math.ceil(span / numSegments))
    const ranges: Array<{ gte: number; lt: number }> = []
    for (let i = 0; i < numSegments; i++) {
      const gte = RANGE_START + i * segSize
      const lt = i === numSegments - 1 ? RANGE_END : RANGE_START + (i + 1) * segSize
      if (gte >= RANGE_END) break
      ranges.push({ gte, lt })
    }
    return ranges
  }

  function pendingState(): StreamState {
    return {
      remaining: [{ gte: toIso(RANGE_START), lt: toIso(RANGE_END), cursor: null }],
    }
  }

  function completeState(): StreamState {
    return { remaining: [] }
  }

  function sourceState(streams: Record<string, StreamState>): SourceState {
    return { streams, global: {} }
  }

  function cloneSourceState(initial?: SourceState): SourceState {
    return {
      streams: { ...initial?.streams },
      global: { ...initial?.global },
    }
  }

  function captureSourceState(
    state: SourceState,
    msg: {
      source_state: {
        state_type?: 'stream' | 'global'
        stream?: string
        data: unknown
      }
    }
  ): void {
    if (msg.source_state.state_type === 'global') {
      state.global = msg.source_state.data as Record<string, unknown>
      return
    }
    if (msg.source_state.stream) {
      state.streams[msg.source_state.stream] = msg.source_state.data as Record<string, unknown>
    }
  }

  async function batchUpsert(table: string, objects: Record<string, unknown>[]) {
    for (let i = 0; i < objects.length; i += SEED_BATCH) {
      await upsertObjects(
        harness.sourcePool,
        SOURCE_SCHEMA,
        table,
        objects.slice(i, i + SEED_BATCH)
      )
    }
  }

  async function replaceTableObjects(table: string, objects: Record<string, unknown>[]) {
    await ensureObjectTable(harness.sourcePool, SOURCE_SCHEMA, table)
    await harness.sourcePool.query(
      `TRUNCATE TABLE ${quoteIdentifier(SOURCE_SCHEMA)}.${quoteIdentifier(table)}`
    )
    if (objects.length > 0) {
      await batchUpsert(table, objects)
    }
  }

  async function seedCustomers(objects: Record<string, unknown>[]) {
    await replaceTableObjects('customer', objects)
  }

  function generateCustomers(count: number, prefix: string): Record<string, unknown>[] {
    const shells = Array.from({ length: count }, (_, i) =>
      makeCustomer(`${prefix}${String(i).padStart(5, '0')}`, 0)
    )
    return applyCreatedTimestampRange(shells, { startUnix: RANGE_START, endUnix: RANGE_END })
  }

  function makePipelineConfig(opts: {
    destSchema: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
  }): PipelineConfig {
    return {
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_fake',
          api_version: BUNDLED_API_VERSION,
          base_url: harness.testServerContainerUrl(),
          ...opts.sourceOverrides,
        },
      },
      destination: {
        type: 'postgres',
        postgres: {
          url: harness.destPgContainerUrl(),
          schema: opts.destSchema,
          batch_size: 100,
        },
      },
      streams: opts.streams ?? [{ name: 'customer', sync_mode: 'full_refresh' }],
    }
  }

  async function runRead(opts: {
    destSchema: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
    state?: SourceState
    time_limit?: number
  }): Promise<{ messages: Message[]; state: SourceState }> {
    const pipeline = makePipelineConfig(opts)
    const messages: Message[] = []
    const state = cloneSourceState(opts.state)

    for await (const msg of engine.pipeline_read(pipeline, {
      state: wrapSyncState(opts.state),
      time_limit: opts.time_limit,
    })) {
      messages.push(msg)
      if (msg.type === 'source_state') {
        captureSourceState(state, msg)
      }
    }

    return { messages, state }
  }

  function wrapSyncState(source?: SourceState) {
    if (!source) return undefined
    return {
      source,
      destination: {},
      sync_run: {
        progress: {
          started_at: new Date().toISOString(),
          elapsed_ms: 0,
          global_state_count: 0,
          derived: {
            status: 'started' as const,
            records_per_second: 0,
            states_per_second: 0,
            total_record_count: 0,
            total_state_count: 0,
          },
          streams: {},
        },
      },
    }
  }

  async function runSync(opts: {
    destSchema: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
    state?: SourceState
    time_limit?: number
  }): Promise<{ messages: SyncOutput[]; state: SourceState }> {
    const pipeline = makePipelineConfig(opts)
    const messages: SyncOutput[] = []
    const state = cloneSourceState(opts.state)

    for await (const setupMsg of engine.pipeline_setup(pipeline)) {
      // Destination Postgres needs setup to create schema/table structures.
      void setupMsg
    }

    for await (const msg of engine.pipeline_sync(pipeline, {
      state: wrapSyncState(opts.state),
      time_limit: opts.time_limit,
    })) {
      messages.push(msg)
      if (msg.type === 'source_state') {
        captureSourceState(state, msg)
      }
    }

    return { messages, state }
  }

  async function countRows(schema: string, table: string): Promise<number> {
    try {
      const { rows } = await harness.destPool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM "${schema}"."${table}"`
      )
      return rows[0]?.c ?? 0
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') return 0
      throw err
    }
  }

  async function listIds(schema: string, table: string): Promise<string[]> {
    try {
      const { rows } = await harness.destPool.query<{ id: string }>(
        `SELECT id FROM "${schema}"."${table}" ORDER BY id`
      )
      return rows.map((row) => row.id)
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') return []
      throw err
    }
  }

  beforeAll(async () => {
    harness = await startEngineHarness()
  }, 10 * 60_000)

  afterAll(async () => {
    for (const schema of createdSchemas) {
      await harness?.destPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    }
    await harness?.close()
  }, 60_000)

  it('created filter boundaries: objects at range edges are not lost or duplicated', async () => {
    const CONC = 5
    const destSchema = uniqueSchema('boundary')
    const ranges = buildSegmentRanges(CONC)
    const internalBoundaries = ranges.slice(0, -1).map((r) => r.lt)

    const boundaryCustomers = internalBoundaries.flatMap((boundary, i) => [
      makeCustomer(`cus_b${i}_at`, boundary),
      makeCustomer(`cus_b${i}_minus1`, boundary - 1),
      makeCustomer(`cus_b${i}_plus1`, boundary + 1),
    ])
    const edgeCustomers = [
      makeCustomer('cus_range_start', RANGE_START),
      makeCustomer('cus_range_start_p1', RANGE_START + 1),
      makeCustomer('cus_range_end_m1', RANGE_END - 1),
    ]
    const expected = [
      ...boundaryCustomers,
      ...edgeCustomers,
      ...generateCustomers(10_000 - boundaryCustomers.length - edgeCustomers.length, 'cus_bfill_'),
    ]

    await seedCustomers(expected)

    const { state } = await runSync({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    const destIds = new Set(await listIds(destSchema, 'customer'))
    for (const customer of expected) {
      expect(
        destIds.has(customer.id as string),
        `missing ${customer.id} (created=${customer.created})`
      ).toBe(true)
    }
    expect(destIds.size).toBe(expected.length)

    const finalState = state.streams.customer as StreamState
    expect(finalState.remaining).toEqual([])
  }, 120_000)

  it('out-of-range objects are excluded by created filter', async () => {
    const destSchema = uniqueSchema('outofrange')
    const namedInRange = [
      makeCustomer('cus_in_start', RANGE_START),
      makeCustomer('cus_in_mid', RANGE_START + 1000),
      makeCustomer('cus_in_end_m1', RANGE_END - 1),
    ]
    const inRange = [...namedInRange, ...generateCustomers(10_000, 'cus_oor_')]
    const outOfRange = [
      makeCustomer('cus_out_before_far', RANGE_START - 100),
      makeCustomer('cus_out_before_1', RANGE_START - 1),
      makeCustomer('cus_out_at_end', RANGE_END),
      makeCustomer('cus_out_after_far', RANGE_END + 100),
    ]

    await seedCustomers([...inRange, ...outOfRange])
    await runSync({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    const ids = new Set(await listIds(destSchema, 'customer'))
    for (const customer of inRange) {
      expect(ids.has(customer.id as string), `expected in-range ${customer.id}`).toBe(true)
    }
    for (const customer of outOfRange) {
      expect(ids.has(customer.id as string), `unexpected out-of-range ${customer.id}`).toBe(false)
    }
    expect(ids.size).toBe(inRange.length)
  }, 120_000)

  it('multi-page: >100 objects in a segment forces pagination', async () => {
    const destSchema = uniqueSchema('multipage')
    const COUNT = 10_000

    await seedCustomers(generateCustomers(COUNT, 'cus_mp_'))

    const { messages } = await runSync({
      destSchema,
    })

    expect(await countRows(destSchema, 'customer')).toBe(COUNT)
    expect(messages.filter((msg) => msg.type === 'source_state').length).toBeGreaterThan(1)
  }, 120_000)

  it('no duplicate record IDs emitted by source across ranges', async () => {
    const CONC = 5
    const destSchema = uniqueSchema('dupcheck')
    const ranges = buildSegmentRanges(CONC)
    const boundaries = ranges.slice(0, -1).map((r) => r.lt)

    const boundaryObjects = boundaries.flatMap((boundary, i) => [
      makeCustomer(`cus_d${i}_at`, boundary),
      makeCustomer(`cus_d${i}_m1`, boundary - 1),
      makeCustomer(`cus_d${i}_p1`, boundary + 1),
    ])
    boundaryObjects.push(makeCustomer('cus_d_start', RANGE_START))
    boundaryObjects.push(makeCustomer('cus_d_end_m1', RANGE_END - 1))

    const objects = [
      ...boundaryObjects,
      ...generateCustomers(10_000 - boundaryObjects.length, 'cus_dfill_'),
    ]

    await seedCustomers(objects)

    const { messages } = await runRead({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    const recordIds = messages
      .filter((msg) => msg.type === 'record')
      .map((msg) => msg.record.data.id)
      .filter((id): id is string => typeof id === 'string')

    expect(recordIds.length, 'source emitted duplicate record IDs').toBe(new Set(recordIds).size)
    expect(recordIds.length).toBe(objects.length)
  }, 120_000)

  it('resume from partially-completed state skips completed ranges', async () => {
    const destSchema = uniqueSchema('resume')
    const CONC = 5
    const ranges = buildSegmentRanges(CONC)
    const PER_RANGE = 2000

    const objects = ranges.flatMap((range, rangeIdx) => {
      const step = Math.max(1, Math.floor((range.lt - range.gte - 2) / PER_RANGE))
      return Array.from({ length: PER_RANGE }, (_, i) =>
        makeCustomer(`cus_seg${rangeIdx}_${String(i).padStart(4, '0')}`, range.gte + 1 + i * step)
      )
    })

    await seedCustomers(objects)

    // Only the last 2 ranges remain — first 3 already completed
    const remainingRanges = ranges.slice(3).map((r) => ({
      gte: toIso(r.gte),
      lt: toIso(r.lt),
      cursor: null,
    }))

    await runSync({
      destSchema,
      state: sourceState({
        customer: { remaining: remainingRanges },
      }),
    })

    const destIds = new Set(await listIds(destSchema, 'customer'))
    for (const rangeIdx of [3, 4]) {
      for (let i = 0; i < PER_RANGE; i++) {
        const id = `cus_seg${rangeIdx}_${String(i).padStart(4, '0')}`
        expect(destIds.has(id), `missing ${id}`).toBe(true)
      }
    }
    for (const rangeIdx of [0, 1, 2]) {
      expect(destIds.has(`cus_seg${rangeIdx}_0000`), `unexpected cus_seg${rangeIdx}_0000`).toBe(
        false
      )
    }
    expect(destIds.size).toBe(PER_RANGE * 2)
  }, 120_000)

  it('empty ranges complete without hanging', async () => {
    const destSchema = uniqueSchema('empty')
    const CONC = 5
    const ranges = buildSegmentRanges(CONC)
    const populatedRanges = [0, 2, 4]
    const perRange = Math.ceil(10_000 / populatedRanges.length)

    const objects = populatedRanges.flatMap((rangeIdx) => {
      const range = ranges[rangeIdx]
      const step = Math.max(1, Math.floor((range.lt - range.gte - 2) / perRange))
      return Array.from({ length: perRange }, (_, i) =>
        makeCustomer(`cus_e${rangeIdx}_${String(i).padStart(4, '0')}`, range.gte + 1 + i * step)
      )
    })

    await seedCustomers(objects)

    const { state } = await runSync({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    expect(await countRows(destSchema, 'customer')).toBe(objects.length)
    expect((state.streams.customer as StreamState).remaining).toEqual([])
  }, 120_000)

  it('second sync after completion emits zero records', async () => {
    const destSchema = uniqueSchema('idempotent')

    await seedCustomers(generateCustomers(10_000, 'cus_idem_'))

    const { messages } = await runSync({
      destSchema,
      state: sourceState({ customer: completeState() }),
    })

    expect(messages.filter((msg) => msg.type === 'source_state').length).toBe(0)
    expect(await countRows(destSchema, 'customer')).toBe(0)
  }, 120_000)

  it('backfill_limit stops fetching after the threshold', async () => {
    const destSchema = uniqueSchema('bflimit')
    const TOTAL = 10_000

    await seedCustomers(generateCustomers(TOTAL, 'cus_bl_'))

    const { messages } = await runSync({
      destSchema,
      streams: [{ name: 'customer', sync_mode: 'full_refresh', backfill_limit: 5 }],
    })

    const synced = await countRows(destSchema, 'customer')
    expect(synced).toBeGreaterThan(0)
    expect(synced).toBeLessThan(TOTAL)
    expect(messages.filter((msg) => msg.type === 'source_state').length).toBeGreaterThan(0)
  }, 120_000)

  it('pagination handles ID/created order mismatch correctly', async () => {
    const destSchema = uniqueSchema('idorder')
    const COUNT = 10_000
    const timestamps = Array.from({ length: 5 }, (_, i) => RANGE_START + (i + 1) * 1000)
    const objects = Array.from({ length: COUNT }, (_, i) =>
      makeCustomer(`cus_tie_${String(i).padStart(5, '0')}`, timestamps[i % timestamps.length]!)
    )

    await seedCustomers(objects)
    await runSync({
      destSchema,
    })

    const destIds = new Set(await listIds(destSchema, 'customer'))
    for (const object of objects) {
      expect(destIds.has(object.id as string), `missing ${object.id}`).toBe(true)
    }
    expect(destIds.size).toBe(COUNT)
  }, 120_000)

  it('syncs multiple streams in a single run', async () => {
    const destSchema = uniqueSchema('multistream')
    const PER_STREAM = 5000
    const range = { startUnix: RANGE_START, endUnix: RANGE_END }

    const customers = applyCreatedTimestampRange(
      Array.from({ length: PER_STREAM }, (_, i) =>
        makeCustomer(`cus_ms_${String(i).padStart(5, '0')}`, 0)
      ),
      range
    )
    const products = applyCreatedTimestampRange(
      Array.from({ length: PER_STREAM }, (_, i) =>
        makeProduct(`prod_ms_${String(i).padStart(5, '0')}`, 0)
      ),
      range
    )

    await Promise.all([
      replaceTableObjects('customer', customers),
      replaceTableObjects('product', products),
    ])

    const { state } = await runSync({
      destSchema,
      streams: [
        { name: 'customer', sync_mode: 'full_refresh' },
        { name: 'product', sync_mode: 'full_refresh' },
      ],
    })

    expect(await countRows(destSchema, 'customer')).toBe(customers.length)
    expect(await countRows(destSchema, 'product')).toBe(products.length)
    expect((state.streams.customer as StreamState).remaining).toEqual([])
    expect((state.streams.product as StreamState).remaining).toEqual([])
  }, 120_000)

  it('zero objects: empty source completes cleanly with no records', async () => {
    const destSchema = uniqueSchema('zerobj')

    await seedCustomers([])

    const { state } = await runSync({
      destSchema,
    })

    expect(await countRows(destSchema, 'customer')).toBe(0)
    expect((state.streams.customer as StreamState).remaining).toEqual([])
  }, 120_000)

  it('single object: exactly one record syncs correctly', async () => {
    const destSchema = uniqueSchema('single')

    await seedCustomers([makeCustomer('cus_only_one', RANGE_START + 500)])

    const { state } = await runSync({
      destSchema,
    })

    const ids = await listIds(destSchema, 'customer')
    expect(ids).toEqual(['cus_only_one'])
    expect((state.streams.customer as StreamState).remaining).toEqual([])
  }, 120_000)

  it('data integrity: destination _raw_data matches source objects', async () => {
    const destSchema = uniqueSchema('integrity')
    const sourceObjects = generateCustomers(10_000, 'cus_int_')

    await seedCustomers(sourceObjects)
    await runSync({
      destSchema,
    })

    expect(await countRows(destSchema, 'customer')).toBe(sourceObjects.length)

    const sample = [sourceObjects[0], sourceObjects[4999], sourceObjects[9999]]
    for (const object of sample) {
      const { rows } = await harness.destPool.query<{ _raw_data: Record<string, unknown> }>(
        `SELECT "_raw_data" FROM "${destSchema}"."customer" WHERE id = $1`,
        [object!.id]
      )
      expect(rows.length, `missing ${object!.id} in destination`).toBe(1)
      const dest = rows[0]!._raw_data
      expect(dest.id).toBe(object!.id)
      expect(dest.created).toBe(object!.created)
      expect(dest.object).toBe('customer')
      expect(dest.email).toBe(object!.email)
    }
  }, 120_000)

  it('multi-page pagination across multiple concurrent ranges', async () => {
    const destSchema = uniqueSchema('multipageseg')
    const CONC = 3
    const ranges = buildSegmentRanges(CONC)
    const PER_RANGE = 3334

    const objects = ranges.flatMap((range, rangeIdx) => {
      const step = Math.max(1, Math.floor((range.lt - range.gte - 2) / PER_RANGE))
      return Array.from({ length: PER_RANGE }, (_, i) =>
        makeCustomer(`cus_mps${rangeIdx}_${String(i).padStart(4, '0')}`, range.gte + 1 + i * step)
      )
    })

    await seedCustomers(objects)

    const { messages, state } = await runSync({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    expect(await countRows(destSchema, 'customer')).toBe(objects.length)
    expect(messages.filter((msg) => msg.type === 'source_state').length).toBeGreaterThan(CONC)
    expect((state.streams.customer as StreamState).remaining).toEqual([])
  }, 120_000)

  it('stress: 25k objects synced successfully', async () => {
    const destSchema = uniqueSchema('stress')
    const TOTAL = 25_000

    const objects = generateCustomers(TOTAL, 'cus_s_')

    await seedCustomers(objects)

    const { state } = await runSync({
      destSchema,
      state: sourceState({ customer: pendingState() }),
    })

    const destIds = new Set(await listIds(destSchema, 'customer'))
    const expectedIds = new Set(objects.map((object) => object.id as string))
    const missing = [...expectedIds].filter((id) => !destIds.has(id))
    const unexpected = [...destIds].filter((id) => !expectedIds.has(id))

    expect(
      missing.length,
      `missing ${missing.length} objects, first 10: ${missing.slice(0, 10).join(', ')}`
    ).toBe(0)
    expect(unexpected.length, `unexpected ${unexpected.length} objects`).toBe(0)
    expect(destIds.size).toBe(TOTAL)
    expect((state.streams.customer as StreamState).remaining).toEqual([])
  }, 600_000)

  it('multiple keys: concurrent syncs with different API keys do not interfere', async () => {
    const COUNT = 5000
    const KEYS = ['sk_test_key_alpha', 'sk_test_key_bravo', 'sk_test_key_charlie']

    await seedCustomers(generateCustomers(COUNT, 'cus_mk_'))

    const syncs = KEYS.map(async (apiKey) => {
      const destSchema = uniqueSchema(`multikey_${apiKey.slice(-5)}`)
      const { state } = await runSync({
        destSchema,
        sourceOverrides: { api_key: apiKey },
      })
      return { apiKey, destSchema, state }
    })

    const results = await Promise.all(syncs)

    for (const { apiKey, destSchema, state } of results) {
      const ids = await listIds(destSchema, 'customer')
      expect(ids.length, `key ${apiKey}: expected ${COUNT} rows`).toBe(COUNT)

      const destIds = new Set(ids)
      for (let i = 0; i < COUNT; i++) {
        const expected = `cus_mk_${String(i).padStart(5, '0')}`
        expect(destIds.has(expected), `key ${apiKey}: missing ${expected}`).toBe(true)
      }

      expect((state.streams.customer as StreamState).remaining).toEqual([])
    }
  }, 180_000)

  it('v2 stream: syncs v2_core_event_destination via cursor pagination', async () => {
    const destSchema = uniqueSchema('v2sync')
    const STREAM = 'v2_core_event_destination'

    const v2Objects = Array.from({ length: 10_000 }, (_, i) => ({
      id: `ed_test_${String(i).padStart(5, '0')}`,
      object: 'v2.core.event_destination',
      description: `Event destination ${i}`,
      status: 'enabled',
      enabled_events: ['*'],
      metadata: {},
    }))

    await replaceTableObjects(STREAM, v2Objects)

    const { state } = await runSync({
      destSchema,
      streams: [{ name: STREAM, sync_mode: 'full_refresh' }],
      sourceOverrides: { api_version: BUNDLED_API_VERSION },
    })

    const destIds = new Set(await listIds(destSchema, STREAM))
    for (const object of v2Objects) {
      expect(destIds.has(object.id), `missing v2 object ${object.id}`).toBe(true)
    }
    expect(destIds.size).toBe(v2Objects.length)
    expect((state.streams[STREAM] as StreamState).remaining).toEqual([])
  }, 120_000)
})
