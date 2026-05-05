import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfiguredCatalog, Message } from '@stripe/sync-protocol'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'
import { createStripeDestination } from './index.js'
import spec, { configSchema } from './spec.js'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function response(json: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function inputMessages(): Message[] {
  return [
    {
      type: 'record',
      record: {
        stream: 'crm_customers',
        data: {
          id: 'crm_123',
          email: 'jenny@example.com',
          name: 'Jenny Rosen',
          plan: 'enterprise',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        emitted_at: '2026-05-03T00:00:00.000Z',
      },
    },
    {
      type: 'source_state',
      source_state: {
        state_type: 'stream',
        stream: 'crm_customers',
        data: { cursor: '2026-01-01T00:00:00.000Z', primary_key: ['crm_123'] },
      },
    },
  ]
}

const customObjectConfig = configSchema.parse({
  api_key: 'sk_test_123',
  api_version: 'unsafe-development',
  base_url: 'https://stripe.test',
  object: 'custom_object',
  write_mode: 'create',
  streams: {
    crm_customers: {
      plural_name: 'loyalty_cards',
      field_mapping: {
        nickname: 'name',
        tier: 'plan',
      },
    },
  },
})

const standardObjectConfig = configSchema.parse({
  api_key: 'sk_test_123',
  api_version: BUNDLED_API_VERSION,
  base_url: 'https://stripe.test',
  object: 'standard_object',
  write_mode: 'create',
  streams: {
    customer: {
      field_mapping: {
        email: 'email',
        name: 'name',
      },
    },
  },
})

const catalog: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'crm_customers',
        primary_key: [['id']],
        newer_than_field: 'updated_at',
      },
      sync_mode: 'incremental',
      destination_sync_mode: 'append',
    },
  ],
}

const standardObjectCatalog: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'customer',
        primary_key: [['id']],
        newer_than_field: 'updated_at',
      },
      sync_mode: 'incremental',
      destination_sync_mode: 'append',
    },
  ],
}

function customObjectDefinitions(fields = ['nickname', 'tier']) {
  return {
    data: [
      {
        id: 'cobjdef_123',
        api_name_plural: 'loyalty_cards',
        api_name_singular: 'loyalty_card',
        properties: Object.fromEntries(fields.map((name) => [name, { type: 'string' }])),
      },
    ],
  }
}

describe('destination-stripe', () => {
  it('rejects unsupported Stripe objects without attempting a write', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ id: 'unexpected' })
      },
    })
    const invoiceConfig = { ...customObjectConfig, object: 'invoice' } as typeof customObjectConfig

    const messages = await collect(
      destination.write({ config: invoiceConfig, catalog }, inputMessages())
    )

    expect(requests).toEqual([])
    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'destination-stripe supports object: "custom_object" or "standard_object"; object "invoice" is not supported',
        },
      },
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error:
            'destination-stripe supports object: "custom_object" or "standard_object"; object "invoice" is not supported',
        },
      },
    ])
  })

  it('rejects unsupported Stripe objects before reading stdin', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ id: 'unexpected' })
      },
    })
    const invoiceConfig = { ...customObjectConfig, object: 'invoice' } as typeof customObjectConfig

    const messages = await collect(destination.write({ config: invoiceConfig, catalog }, []))

    expect(requests).toEqual([])
    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'destination-stripe supports object: "custom_object" or "standard_object"; object "invoice" is not supported',
        },
      },
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error:
            'destination-stripe supports object: "custom_object" or "standard_object"; object "invoice" is not supported',
        },
      },
    ])
  })

  it('validates Custom Object and standard object config through the JSON Schema path', () => {
    const jsonSchemaConfig = z.fromJSONSchema(spec.config)
    const { streams: _streams, ...missingStreamsConfig } = customObjectConfig

    expect(jsonSchemaConfig.safeParse(customObjectConfig).success).toBe(true)
    expect(jsonSchemaConfig.safeParse(standardObjectConfig).success).toBe(true)
    for (const invalidConfig of [
      missingStreamsConfig,
      { ...customObjectConfig, api_version: '2026-03-25.dahlia' },
      { ...customObjectConfig, object: 'customer' },
      { ...customObjectConfig, write_mode: 'upsert' },
      { ...standardObjectConfig, api_version: 'unsafe-development' },
      { ...standardObjectConfig, object: 'customer' },
      { ...standardObjectConfig, streams: { customer: {} } },
      {
        ...standardObjectConfig,
        streams: { customer: { field_mapping: { email: 'email' } } },
        mode: 'upsert',
      },
      { ...customObjectConfig, identity: { external_id_field: 'id' } },
      { ...customObjectConfig, fields: { email: 'email' } },
      { ...customObjectConfig, plural_name: 'loyalty_cards' },
      { ...customObjectConfig, field_mapping: { nickname: 'name' } },
      { ...customObjectConfig, stripe_record_id_field: 'stripe_custom_object_id' },
      { ...customObjectConfig, auto_map_fields: true },
    ]) {
      expect(jsonSchemaConfig.safeParse(invalidConfig).success).toBe(false)
      expect(configSchema.safeParse(invalidConfig).success).toBe(false)
    }
  })

  it('creates a standard object with mapped form parameters', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ id: 'cus_123', object: 'customer' })
      },
    })

    const messages = await collect(
      destination.write({ config: standardObjectConfig, catalog: standardObjectCatalog }, [
        {
          type: 'record',
          record: {
            stream: 'customer',
            data: {
              id: 'crm_123',
              email: 'jenny@example.com',
              name: 'Jenny Rosen',
              plan: 'enterprise',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
            emitted_at: '2026-05-03T00:00:00.000Z',
          },
        },
        {
          type: 'source_state',
          source_state: {
            state_type: 'stream',
            stream: 'customer',
            data: { cursor: '2026-01-01T00:00:00.000Z', primary_key: ['crm_123'] },
          },
        },
      ])
    )

    expect(messages.map((message) => message.type)).toEqual(['record', 'source_state'])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://stripe.test/v1/customers')
    expect(requests[0]!.init?.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(requests[0]!.init?.body)))).toEqual({
      email: 'jenny@example.com',
      name: 'Jenny Rosen',
    })
    expect((requests[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    )
    expect((requests[0]!.init?.headers as Record<string, string>)['Stripe-Version']).toBe(
      BUNDLED_API_VERSION
    )
    expect((requests[0]!.init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^reverse-etl-/
    )
  })

  it('fails standard object check for unknown mapped create parameters', async () => {
    const destination = createStripeDestination({
      fetch: async () => response({ id: 'unexpected' }),
    })
    const invalidConfig = configSchema.parse({
      ...standardObjectConfig,
      streams: {
        customer: {
          field_mapping: {
            not_a_customer_param: 'email',
          },
        },
      },
    })

    const messages = await collect(destination.check({ config: invalidConfig }))

    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'Standard object stream "customer" does not define create parameter(s): not_a_customer_param',
        },
      },
    ])
  })

  it('checks Custom Object definitions with the unsafe-development version header', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response(customObjectDefinitions())
      },
    })

    const messages = await collect(destination.check({ config: customObjectConfig }))

    expect(messages).toEqual([
      { type: 'connection_status', connection_status: { status: 'succeeded' } },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://stripe.test/v2/extend/object_definitions')
    expect((requests[0]!.init?.headers as Record<string, string>)['Stripe-Version']).toBe(
      'unsafe-development'
    )
    expect((requests[0]!.init?.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('fails Custom Object check when no definitions exist', async () => {
    const destination = createStripeDestination({
      fetch: async () => response({ data: [] }),
    })

    const messages = await collect(destination.check({ config: customObjectConfig }))

    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'No Stripe Custom Object definitions found; cannot validate configured custom object streams',
        },
      },
    ])
  })

  it('fails Custom Object check for unknown plural_name', async () => {
    const destination = createStripeDestination({
      fetch: async () =>
        response({
          data: [{ api_name_plural: 'other_cards', properties: { nickname: { type: 'string' } } }],
        }),
    })

    const messages = await collect(destination.check({ config: customObjectConfig }))

    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'Stripe Custom Object definition "loyalty_cards" for stream "crm_customers" was not found',
        },
      },
    ])
  })

  it('fails Custom Object check for unknown mapped fields', async () => {
    const destination = createStripeDestination({
      fetch: async () => response(customObjectDefinitions(['nickname'])),
    })

    const messages = await collect(destination.check({ config: customObjectConfig }))

    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: {
          status: 'failed',
          message:
            'Stripe Custom Object "loyalty_cards" for stream "crm_customers" does not define mapped field(s): tier',
        },
      },
    ])
  })

  it('withholds source_state when Custom Object setup fails before records', async () => {
    const destination = createStripeDestination({
      fetch: async () => response({ data: [] }),
    })

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog }, [
        {
          type: 'source_state',
          source_state: {
            state_type: 'stream',
            stream: 'crm_customers',
            data: { cursor: '2026-01-01T00:00:00.000Z' },
          },
        },
        {
          type: 'source_state',
          source_state: {
            state_type: 'global',
            data: { cursor: 'global_cursor_after_setup_failure' },
          },
        },
      ])
    )

    const error =
      'No Stripe Custom Object definitions found; cannot validate configured custom object streams'
    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: error },
      },
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error,
        },
      },
    ])
  })

  it('fails setup when a selected Custom Object stream is unmapped', async () => {
    const destination = createStripeDestination({
      fetch: async () =>
        response({
          data: [
            customObjectDefinitions().data[0],
            {
              id: 'cobjdef_456',
              api_name_plural: 'account_cards',
              api_name_singular: 'account_card',
              properties: { label: { type: 'string' } },
            },
          ],
        }),
    })
    const multiStreamCatalog: ConfiguredCatalog = {
      streams: [
        ...catalog.streams,
        {
          stream: {
            name: 'crm_accounts',
            primary_key: [['id']],
            newer_than_field: 'updated_at',
          },
          sync_mode: 'incremental',
          destination_sync_mode: 'append',
        },
      ],
    }

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog: multiStreamCatalog }, [
        {
          type: 'source_state',
          source_state: {
            state_type: 'stream',
            stream: 'crm_accounts',
            data: { cursor: '2026-01-01T00:00:00.000Z' },
          },
        },
      ])
    )

    const error = 'No Stripe Custom Object stream config found for stream "crm_accounts"'
    expect(messages).toEqual([
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: error },
      },
      {
        type: 'stream_status',
        stream_status: { stream: 'crm_customers', status: 'error', error },
      },
      {
        type: 'stream_status',
        stream_status: { stream: 'crm_accounts', status: 'error', error },
      },
    ])
  })

  it('creates a Custom Object with JSON fields and passes source_state after success', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return response(customObjectDefinitions())
        }
        return response({ id: 'co_123', object: 'v2.extend.object' })
      },
    })

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog }, inputMessages())
    )

    expect(messages.map((message) => message.type)).toEqual(['record', 'source_state'])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe('https://stripe.test/v2/extend/objects/loyalty_cards')
    expect(requests[1]!.init?.method).toBe('POST')
    expect(requests[1]!.init?.body).toBe(
      JSON.stringify({ fields: { nickname: 'Jenny Rosen', tier: 'enterprise' } })
    )
    expect((requests[1]!.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
    expect((requests[1]!.init?.headers as Record<string, string>)['Stripe-Version']).toBe(
      'unsafe-development'
    )
  })

  it('routes multiple streams to different Custom Object plural names', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return response({
            data: [
              customObjectDefinitions().data[0],
              {
                id: 'cobjdef_456',
                api_name_plural: 'account_cards',
                api_name_singular: 'account_card',
                properties: { label: { type: 'string' } },
              },
            ],
          })
        }
        return response({ id: 'co_123', object: 'v2.extend.object' })
      },
    })
    const multiStreamConfig = configSchema.parse({
      ...customObjectConfig,
      streams: {
        crm_customers: customObjectConfig.streams.crm_customers,
        crm_accounts: {
          plural_name: 'account_cards',
          field_mapping: { label: 'name' },
        },
      },
    })
    const multiStreamCatalog: ConfiguredCatalog = {
      streams: [
        ...catalog.streams,
        {
          stream: {
            name: 'crm_accounts',
            primary_key: [['id']],
            newer_than_field: 'updated_at',
          },
          sync_mode: 'incremental',
          destination_sync_mode: 'append',
        },
      ],
    }
    const input: Message[] = [
      inputMessages()[0]!,
      {
        type: 'record',
        record: {
          stream: 'crm_accounts',
          data: {
            id: 'acct_123',
            name: 'Enterprise account',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          emitted_at: '2026-05-03T00:00:00.000Z',
        },
      },
    ]

    const output = await collect(
      destination.write({ config: multiStreamConfig, catalog: multiStreamCatalog }, input)
    )

    expect(output.map((message) => message.type)).toEqual(['record', 'record'])
    expect(requests.map((request) => request.url)).toEqual([
      'https://stripe.test/v2/extend/object_definitions',
      'https://stripe.test/v2/extend/objects/loyalty_cards',
      'https://stripe.test/v2/extend/objects/account_cards',
    ])
    expect(requests[1]!.init?.body).toBe(
      JSON.stringify({ fields: { nickname: 'Jenny Rosen', tier: 'enterprise' } })
    )
    expect(requests[2]!.init?.body).toBe(
      JSON.stringify({ fields: { label: 'Enterprise account' } })
    )
  })

  it('withholds source_state after a failed Custom Object write', async () => {
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url) => {
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return response(customObjectDefinitions())
        }
        return response({ error: { message: 'custom object invalid' } }, { status: 400 })
      },
    })

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog }, inputMessages())
    )

    expect(messages).toEqual([
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error: 'custom object invalid',
        },
      },
    ])
  })

  it('retries retryable non-JSON Stripe errors', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    let sleeps = 0
    const destination = createStripeDestination({
      sleep: async () => {
        sleeps += 1
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return response(customObjectDefinitions())
        }
        if (
          requests.filter((request) => request.url.endsWith('/v2/extend/objects/loyalty_cards'))
            .length === 1
        ) {
          return new Response('temporary upstream failure', {
            status: 500,
            headers: { 'content-type': 'text/plain' },
          })
        }
        return response({ id: 'co_123', object: 'v2.extend.object' })
      },
    })

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog }, [inputMessages()[0]!])
    )

    expect(messages.map((message) => message.type)).toEqual(['record'])
    expect(requests.map((request) => request.url)).toEqual([
      'https://stripe.test/v2/extend/object_definitions',
      'https://stripe.test/v2/extend/objects/loyalty_cards',
      'https://stripe.test/v2/extend/objects/loyalty_cards',
    ])
    expect(sleeps).toBe(1)
  })

  it('withholds global source_state after any Custom Object write failure', async () => {
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url) => {
        if (String(url).endsWith('/v2/extend/object_definitions')) {
          return response(customObjectDefinitions())
        }
        return response({ error: { message: 'custom object invalid' } }, { status: 400 })
      },
    })

    const messages = await collect(
      destination.write({ config: customObjectConfig, catalog }, [
        ...inputMessages(),
        {
          type: 'source_state',
          source_state: {
            state_type: 'global',
            data: { cursor: 'global_cursor_after_failed_record' },
          },
        },
      ])
    )

    expect(messages).toEqual([
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error: 'custom object invalid',
        },
      },
    ])
  })
})
