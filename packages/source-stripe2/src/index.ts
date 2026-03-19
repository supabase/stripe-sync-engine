import Stripe from 'stripe'
import { z } from 'zod'
import type {
  ConfiguredCatalog,
  ConnectorSpecification,
  Message,
  Source,
  StateMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'

// MARK: - Spec

export const spec = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for stripe-mock)'),
})

export type Config = z.infer<typeof spec>

// MARK: - Resources

const resources = {
  product: {
    table: 'products',
    list: (s: Stripe) => (p: any) => s.products.list(p),
  },
  customer: {
    table: 'customers',
    list: (s: Stripe) => (p: any) => s.customers.list(p),
  },
  price: {
    table: 'prices',
    list: (s: Stripe) => (p: any) => s.prices.list(p),
  },
  invoice: {
    table: 'invoices',
    list: (s: Stripe) => (p: any) => s.invoices.list(p),
  },
}

// MARK: - Helpers

function makeClient(config: Config): Stripe {
  if (config.base_url) {
    const url = new URL(config.base_url)
    return new Stripe(config.api_key, {
      host: url.hostname,
      port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
    })
  }
  return new Stripe(config.api_key)
}

// MARK: - Source

const source = {
  spec() {
    return { connection_specification: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    try {
      const s = makeClient(config)
      await s.accounts.retrieve()
      return { status: 'succeeded' as const }
    } catch (err: any) {
      return { status: 'failed' as const, message: err.message }
    }
  },

  async discover({ config }) {
    return {
      type: 'catalog' as const,
      streams: Object.entries(resources).map(([name, r]) => ({
        name: r.table,
        primary_key: [['id']],
        metadata: { resource_name: name },
      })),
    }
  },

  async *read({ config, catalog, state }) {
    const s = makeClient(config)

    // Resolve configured streams to resource entries
    const selectedNames = new Set(catalog.streams.map((cs) => cs.stream.name))
    const entries = Object.entries(resources).filter(([, r]) => selectedNames.has(r.table))

    for (const [, resource] of entries) {
      const streamState = state?.find((st) => st.stream === resource.table)
      let cursor: string | null = (streamState?.data as any)?.pageCursor ?? null

      yield { type: 'stream_status', stream: resource.table, status: 'started' }

      const listFn = resource.list(s)
      let hasMore = true

      while (hasMore) {
        const params: any = { limit: 100 }
        if (cursor) params.starting_after = cursor

        const response = await listFn(params)

        for (const item of response.data) {
          yield toRecordMessage(resource.table, item as unknown as Record<string, unknown>)
        }

        hasMore = response.has_more
        if (response.data.length > 0) {
          cursor = (response.data.at(-1) as any).id
        }

        yield {
          type: 'state',
          stream: resource.table,
          data: {
            pageCursor: hasMore ? cursor : null,
            status: hasMore ? 'pending' : 'complete',
          },
        }
      }

      yield {
        type: 'stream_status',
        stream: resource.table,
        status: 'complete',
      }
    }
  },
} satisfies Source<Config>

export default source
