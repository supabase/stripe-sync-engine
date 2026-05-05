import { describe, expect, it } from 'vitest'
import type { ConnectorResolver, ResolvedConnector } from './resolver.js'
import type { Destination, Source } from '@stripe/sync-protocol'
import { createEngine } from './engine.js'
import { createPostgresSource } from '@stripe/sync-source-postgres'
import { createStripeDestination } from '@stripe/sync-destination-stripe'

function makeResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
    sources: () => new Map<string, ResolvedConnector<Source>>(),
    destinations: () => new Map<string, ResolvedConnector<Destination>>(),
  }
}

function queryResult<T extends Record<string, unknown>>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  }
}

function stripeResponse(json: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('reverse ETL', () => {
  it('advances source_state through insert-only standard object creates', async () => {
    const rows = [
      {
        id: 'crm_123',
        email: 'jenny@example.com',
        full_name: 'Jenny Rosen',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    const stripeRequests: Array<{ url: string; init?: RequestInit }> = []

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(text: string, values?: unknown[]) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'email', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'full_name', data_type: 'text', is_nullable: 'NO' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }

          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          return queryResult(rows.filter((row) => !cursor || row.updated_at > cursor))
        },
        async end() {},
      }),
    })

    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        stripeRequests.push({ url: String(url), init })
        return stripeResponse({
          id: 'cus_123',
          object: 'customer',
        })
      },
    })

    const engine = await createEngine(makeResolver(source, destination))
    const result = await engine.pipeline_sync_batch(
      {
        source: {
          type: 'postgres',
          postgres: {
            url: 'postgres://example',
            table: 'customers',
            stream: 'customer',
            primary_key: ['id'],
            cursor_field: 'updated_at',
            page_size: 100,
          },
        },
        destination: {
          type: 'stripe',
          stripe: {
            api_key: 'sk_test_123',
            api_version: '2026-03-25.dahlia',
            base_url: 'https://stripe.test',
            object: 'standard_object',
            write_mode: 'create',
            streams: {
              customer: {
                field_mapping: {
                  email: 'email',
                  name: 'full_name',
                },
              },
            },
          },
        },
        streams: [{ name: 'customer', sync_mode: 'incremental' }],
      },
      { run_id: 'run_reverse_etl_standard_object_create_test' }
    )

    expect(result.ending_state?.source.streams.customer).toEqual({
      cursor: '2026-01-01T00:00:00.000Z',
      primary_key: ['crm_123'],
    })
    expect(stripeRequests.map((request) => request.url)).toEqual([
      'https://stripe.test/v1/customers',
    ])
    expect(Object.fromEntries(new URLSearchParams(String(stripeRequests[0]!.init?.body)))).toEqual({
      email: 'jenny@example.com',
      name: 'Jenny Rosen',
    })
  })

  it('advances source_state through append-only Custom Object creates', async () => {
    const rows = [
      {
        id: 'device_123',
        name: 'living room tv',
        time_from_harvest: '2 days',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    const stripeRequests: Array<{ url: string; init?: RequestInit }> = []

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(text: string, values?: unknown[]) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'time_from_harvest', data_type: 'text', is_nullable: 'YES' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }

          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          return queryResult(rows.filter((row) => !cursor || row.updated_at > cursor))
        },
        async end() {},
      }),
    })

    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        stripeRequests.push({ url: String(url), init })
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return stripeResponse({
            data: [
              {
                id: 'cobjdef_matcha',
                api_name_plural: 'matcha_objects',
                properties: {
                  name: { type: 'string' },
                  time_from_harvest: { type: 'string' },
                },
              },
            ],
          })
        }
        return stripeResponse({
          id: 'objrec_test_123',
          object: 'v2.extend.objects.matcha_object',
        })
      },
    })

    const engine = await createEngine(makeResolver(source, destination))
    const result = await engine.pipeline_sync_batch(
      {
        source: {
          type: 'postgres',
          postgres: {
            url: 'postgres://example',
            table: 'devices',
            primary_key: ['id'],
            cursor_field: 'updated_at',
            page_size: 100,
          },
        },
        destination: {
          type: 'stripe',
          stripe: {
            api_key: 'sk_test_123',
            api_version: 'unsafe-development',
            base_url: 'https://stripe.test',
            object: 'custom_object',
            write_mode: 'create',
            streams: {
              devices: {
                plural_name: 'matcha_objects',
                field_mapping: {
                  name: 'name',
                  time_from_harvest: 'time_from_harvest',
                },
              },
            },
          },
        },
        streams: [{ name: 'devices', sync_mode: 'incremental' }],
      },
      { run_id: 'run_reverse_etl_custom_object_create_test' }
    )

    expect(result.ending_state?.source.streams.devices).toEqual({
      cursor: '2026-01-01T00:00:00.000Z',
      primary_key: ['device_123'],
    })
    expect(stripeRequests.map((request) => request.url)).toEqual([
      'https://stripe.test/v2/extend/object_definitions',
      'https://stripe.test/v2/extend/objects/matcha_objects',
    ])
    expect(stripeRequests[1]!.init?.body).toBe(
      JSON.stringify({ fields: { name: 'living room tv', time_from_harvest: '2 days' } })
    )
  })

  it('creates a new Custom Object record when the same source row changes twice', async () => {
    let rows = [
      {
        id: 'device_123',
        name: 'living room tv',
        time_from_harvest: '2 days',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    const stripeRequests: Array<{ url: string; init?: RequestInit }> = []

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(text: string, values?: unknown[]) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'time_from_harvest', data_type: 'text', is_nullable: 'YES' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }

          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          return queryResult(rows.filter((row) => !cursor || row.updated_at > cursor))
        },
        async end() {},
      }),
    })

    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        stripeRequests.push({ url: String(url), init })
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return stripeResponse({
            data: [
              {
                id: 'cobjdef_matcha',
                api_name_plural: 'matcha_objects',
                properties: {
                  name: { type: 'string' },
                  time_from_harvest: { type: 'string' },
                },
              },
            ],
          })
        }
        return stripeResponse({
          id: `objrec_test_${stripeRequests.length}`,
          object: 'v2.extend.objects.matcha_object',
        })
      },
    })

    const pipeline = {
      source: {
        type: 'postgres',
        postgres: {
          url: 'postgres://example',
          table: 'devices',
          primary_key: ['id'],
          cursor_field: 'updated_at',
          page_size: 100,
        },
      },
      destination: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_123',
          api_version: 'unsafe-development',
          base_url: 'https://stripe.test',
          object: 'custom_object',
          write_mode: 'create',
          streams: {
            devices: {
              plural_name: 'matcha_objects',
              field_mapping: {
                name: 'name',
                time_from_harvest: 'time_from_harvest',
              },
            },
          },
        },
      },
      streams: [{ name: 'devices', sync_mode: 'incremental' as const }],
    }

    const engine = await createEngine(makeResolver(source, destination))
    const first = await engine.pipeline_sync_batch(pipeline, {
      run_id: 'run_reverse_etl_custom_object_create_twice_test',
    })

    rows = [
      {
        id: 'device_123',
        name: 'living room tv',
        time_from_harvest: '3 days',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ]
    const second = await engine.pipeline_sync_batch(pipeline, {
      state: first.ending_state,
      run_id: 'run_reverse_etl_custom_object_create_twice_test',
    })

    expect(first.ending_state?.source.streams.devices).toEqual({
      cursor: '2026-01-01T00:00:00.000Z',
      primary_key: ['device_123'],
    })
    expect(second.ending_state?.source.streams.devices).toEqual({
      cursor: '2026-01-02T00:00:00.000Z',
      primary_key: ['device_123'],
    })
    expect(stripeRequests.map((request) => request.url)).toEqual([
      'https://stripe.test/v2/extend/object_definitions',
      'https://stripe.test/v2/extend/objects/matcha_objects',
      'https://stripe.test/v2/extend/object_definitions',
      'https://stripe.test/v2/extend/objects/matcha_objects',
    ])
    expect(stripeRequests[1]!.init?.body).toBe(
      JSON.stringify({ fields: { name: 'living room tv', time_from_harvest: '2 days' } })
    )
    expect(stripeRequests[3]!.init?.body).toBe(
      JSON.stringify({ fields: { name: 'living room tv', time_from_harvest: '3 days' } })
    )
  })

  it('withholds source_state when Custom Object create fails', async () => {
    const rows = [
      {
        id: 'device_123',
        name: 'living room tv',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(text: string, values?: unknown[]) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }
          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          return queryResult(rows.filter((row) => !cursor || row.updated_at > cursor))
        },
        async end() {},
      }),
    })

    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url) => {
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return stripeResponse({
            data: [
              {
                id: 'cobjdef_matcha',
                api_name_plural: 'matcha_objects',
                properties: { name: { type: 'string' } },
              },
            ],
          })
        }
        return stripeResponse({ error: { message: 'custom object invalid' } }, { status: 400 })
      },
    })

    const engine = await createEngine(makeResolver(source, destination))
    const result = await engine.pipeline_sync_batch(
      {
        source: {
          type: 'postgres',
          postgres: {
            url: 'postgres://example',
            table: 'devices',
            primary_key: ['id'],
            cursor_field: 'updated_at',
            page_size: 100,
          },
        },
        destination: {
          type: 'stripe',
          stripe: {
            api_key: 'sk_test_123',
            api_version: 'unsafe-development',
            base_url: 'https://stripe.test',
            object: 'custom_object',
            write_mode: 'create',
            streams: {
              devices: {
                plural_name: 'matcha_objects',
                field_mapping: {
                  name: 'name',
                },
              },
            },
          },
        },
        streams: [{ name: 'devices', sync_mode: 'incremental' }],
      },
      { run_id: 'run_reverse_etl_custom_object_create_failure_test' }
    )

    expect(result.status).toBe('failed')
    expect(result.ending_state?.source.streams.devices).toBeUndefined()
  })

  it('withholds source_state when Custom Object setup fails before records', async () => {
    const source: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check() {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: {
            streams: [
              {
                name: 'devices',
                primary_key: [['id']],
                newer_than_field: 'updated_at',
                json_schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    updated_at: { type: 'string' },
                  },
                },
              },
            ],
          },
        }
      },
      async *read() {
        yield {
          type: 'source_state',
          source_state: {
            state_type: 'stream',
            stream: 'devices',
            data: { cursor: '2026-01-01T00:00:00.000Z', primary_key: ['device_123'] },
          },
        }
        yield {
          type: 'source_state',
          source_state: {
            state_type: 'global',
            data: { cursor: 'global_cursor_after_setup_failure' },
          },
        }
      },
    }
    const destination = createStripeDestination({
      fetch: async () => stripeResponse({ data: [] }),
    })
    const engine = await createEngine(makeResolver(source, destination))

    const result = await engine.pipeline_sync_batch(
      {
        source: { type: 'state_only', state_only: {} },
        destination: {
          type: 'stripe',
          stripe: {
            api_key: 'sk_test_123',
            api_version: 'unsafe-development',
            base_url: 'https://stripe.test',
            object: 'custom_object',
            write_mode: 'create',
            streams: {
              devices: {
                plural_name: 'matcha_objects',
                field_mapping: {
                  name: 'name',
                },
              },
            },
          },
        },
        streams: [{ name: 'devices', sync_mode: 'incremental' }],
      },
      { run_id: 'run_reverse_etl_custom_object_setup_failure_test' }
    )

    expect(result.status).toBe('failed')
    expect(result.run_progress.derived.total_state_count).toBe(0)
    expect(result.ending_state?.source.streams.devices).toBeUndefined()
    expect(result.ending_state?.source.global).toEqual({})
  })
})
