import { describe, it, expect } from 'vitest'
import spec, { configSchema } from './spec.js'
import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

describe('configSchema api_version field', () => {
  it('only accepts known enum values', () => {
    expect(configSchema.shape.api_version.safeParse(BUNDLED_API_VERSION).success).toBe(true)
    expect(configSchema.shape.api_version.safeParse('2099-01-01.unknown').success).toBe(false)
    expect(configSchema.shape.api_version.safeParse(undefined).success).toBe(true)
  })

  it('exposes supported versions via JSON Schema enum', () => {
    const jsonSchema = spec.config as {
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
    const schema = spec.config as {
      properties?: Record<string, { enum?: string[] }>
    }
    const versions: string[] = schema.properties?.api_version?.enum ?? []

    expect(versions).toContain(BUNDLED_API_VERSION)
    expect(versions.length).toBeGreaterThan(0)
  })
})
