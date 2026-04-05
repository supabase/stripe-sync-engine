import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { configSchema } from './spec.js'
import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

describe('configSchema api_version field', () => {
  it('exposes supported versions via JSON Schema enum', () => {
    const jsonSchema = z.toJSONSchema(configSchema) as {
      properties?: Record<string, { enum?: string[]; description?: string }>
    }
    const field = jsonSchema.properties?.api_version

    expect(field).toBeDefined()
    expect(field!.enum).toEqual([...SUPPORTED_API_VERSIONS])
    expect(field!.description).toContain(BUNDLED_API_VERSION)
  })

  it('clients can extract supported API versions from config_schema', () => {
    // This is the pattern clients use: read config_schema from
    // GET /meta/sources/stripe, then inspect the api_version field.
    const schema = z.toJSONSchema(configSchema) as {
      properties?: Record<string, { enum?: string[] }>
    }
    const versions: string[] = schema.properties?.api_version?.enum ?? []

    expect(versions).toContain(BUNDLED_API_VERSION)
    expect(versions.length).toBeGreaterThan(0)
  })
})
