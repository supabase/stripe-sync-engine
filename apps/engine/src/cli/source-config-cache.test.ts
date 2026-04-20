import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyControlToPipeline,
  readPersistedStripeSourceConfig,
  writePersistedStripeSourceConfig,
} from './source-config-cache.js'

describe('source-config-cache', () => {
  it('persists only resolved Stripe account metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stripe-sync-'))
    const filePath = join(dir, 'source-config.json')

    writePersistedStripeSourceConfig(filePath, {
      api_key: 'sk_test_secret',
      account_id: 'acct_test_123',
      account_created: 1_700_000_000,
      webhook_secret: 'whsec_secret',
    })

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      account_id: 'acct_test_123',
      account_created: 1_700_000_000,
    })
    expect(readPersistedStripeSourceConfig(filePath)).toEqual({
      account_id: 'acct_test_123',
      account_created: 1_700_000_000,
    })
  })

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
