import { describe, expect, it } from 'vitest'
import { applyControlToPipeline } from './source-config-cache.js'

describe('applyControlToPipeline', () => {
  it('applies source_config controls as full source replacements', () => {
    const pipeline = {
      source: { type: 'stripe', stripe: { api_key: 'sk_test' } },
      destination: { type: 'postgres', postgres: { url: 'postgres://test' } },
    }

    const updated = applyControlToPipeline(pipeline, {
      control_type: 'source_config',
      source_config: {
        api_key: 'sk_test',
        account_id: 'acct_test_123',
        account_created: 1_700_000_000,
      },
    })

    expect(updated).toEqual({
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test',
          account_id: 'acct_test_123',
          account_created: 1_700_000_000,
        },
      },
      destination: { type: 'postgres', postgres: { url: 'postgres://test' } },
    })
  })
})
