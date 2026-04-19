import { describe, expect, it } from 'vitest'
import {
  applyConnectorShorthand,
  assertNoAmbiguousConnectorNames,
  normalizeCliKey,
  parseCliValue,
  setNestedValue,
  wrapPipelineConnectorShorthand,
} from './cli-connector-shorthand.js'

describe('cli connector shorthand', () => {
  it('normalizes kebab-case and camelCase keys to snake_case', () => {
    expect(normalizeCliKey('google_sheets')).toBe('google_sheets')
    expect(normalizeCliKey('api-key')).toBe('api_key')
    expect(normalizeCliKey('roleArn')).toBe('role_arn')
  })

  it('parses JSON scalar and collection values', () => {
    expect(parseCliValue('true')).toBe(true)
    expect(parseCliValue('5432')).toBe(5432)
    expect(parseCliValue('["customers"]')).toEqual(['customers'])
    expect(parseCliValue('plain-text')).toBe('plain-text')
  })

  it('sets nested values on plain objects', () => {
    const target: Record<string, unknown> = {}
    setNestedValue(target, ['aws', 'role_arn'], 'arn:aws:iam::123:role/demo')
    expect(target).toEqual({ aws: { role_arn: 'arn:aws:iam::123:role/demo' } })
  })

  it('returns args unchanged when no shorthand flags are present', () => {
    const args = { source: '{"type":"stripe","stripe":{"api_key":"sk"}}' }
    expect(applyConnectorShorthand(args, 'source', ['stripe'])).toEqual(args)
  })

  it('builds a source body from shorthand flags', () => {
    const result = applyConnectorShorthand(
      {
        'stripe.api-key': 'sk_test_123',
        'stripe.api-version': '2025-03-31.basil',
      },
      'source',
      ['stripe']
    )

    expect(JSON.parse(String(result.source))).toEqual({
      type: 'stripe',
      stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
    })
  })

  it('supports nested shorthand keys and JSON values', () => {
    const result = applyConnectorShorthand(
      {
        'postgres.connection-string': 'postgres://localhost/db',
        'postgres.schema': 'public',
        'postgres.aws.region': 'us-west-2',
        'postgres.aws.role-arn': 'arn:aws:iam::123:role/demo',
        'postgres.port': '6543',
        'postgres.ssl-ca-pem': '{"pem":"value"}',
      },
      'destination',
      ['postgres', 'google_sheets']
    )

    expect(JSON.parse(String(result.destination))).toEqual({
      type: 'postgres',
      postgres: {
        connection_string: 'postgres://localhost/db',
        schema: 'public',
        port: 6543,
        aws: {
          region: 'us-west-2',
          role_arn: 'arn:aws:iam::123:role/demo',
        },
        ssl_ca_pem: { pem: 'value' },
      },
    })
  })

  it('merges shorthand into an explicit body for the same connector', () => {
    const result = applyConnectorShorthand(
      {
        destination: '{"type":"postgres","postgres":{"schema":"public"}}',
        'postgres.connection-string': 'postgres://localhost/db',
      },
      'destination',
      ['postgres', 'google_sheets']
    )

    expect(JSON.parse(String(result.destination))).toEqual({
      type: 'postgres',
      postgres: {
        schema: 'public',
        connection_string: 'postgres://localhost/db',
      },
    })
  })

  it('rejects multiple shorthand connectors for the same body', () => {
    expect(() =>
      applyConnectorShorthand(
        {
          'postgres.schema': 'public',
          'google_sheets.access-token': 'token',
        },
        'destination',
        ['postgres', 'google_sheets']
      )
    ).toThrow('Multiple destination connectors specified via shorthand flags')
  })

  it('rejects explicit bodies with a conflicting connector type', () => {
    expect(() =>
      applyConnectorShorthand(
        {
          destination: '{"type":"google_sheets","google_sheets":{"access_token":"token"}}',
          'postgres.schema': 'public',
        },
        'destination',
        ['postgres', 'google_sheets']
      )
    ).toThrow('--destination type google_sheets conflicts with shorthand flags for postgres')
  })

  it('rejects connector names that appear in both source and destination sets', () => {
    expect(() =>
      assertNoAmbiguousConnectorNames(['stripe', 'shared_connector'], ['postgres', 'shared-connector'])
    ).toThrow('Connector names cannot exist in both source and destination sets')
  })

  it('fails wrapper creation when source and destination connector names overlap', () => {
    expect(() =>
      wrapPipelineConnectorShorthand({} as any, {
        sources: ['shared_connector'],
        destinations: ['shared-connector'],
      })
    ).toThrow('Connector names cannot exist in both source and destination sets')
  })
})
