import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./aws', () => ({
  buildRdsIamPasswordFn: vi.fn(),
}))

import { buildPoolConfig, type Config } from './index.js'
import { buildRdsIamPasswordFn } from './aws.js'

const mockPasswordFn = vi.fn().mockResolvedValue('rds-token')
const mockBuild = vi.mocked(buildRdsIamPasswordFn)

describe('buildPoolConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuild.mockResolvedValue(mockPasswordFn)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('connection_string without sslmode → ssl: false', async () => {
    const config: Config = {
      connection_string: 'postgres://user:pass@localhost:5432/mydb',
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }

    const result = await buildPoolConfig(config)
    expect(result).toEqual({
      connectionString: 'postgres://user:pass@localhost:5432/mydb',
      ssl: false,
    })
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it('sslmode=disable → ssl: false', async () => {
    const config: Config = {
      connection_string: 'postgres://user:pass@localhost:5432/mydb?sslmode=disable',
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }
    const result = await buildPoolConfig(config)
    expect(result.ssl).toBe(false)
  })

  it('sslmode=verify-full → ssl: true', async () => {
    const config: Config = {
      connection_string: 'postgres://user:pass@host:5432/mydb?sslmode=verify-full',
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }
    const result = await buildPoolConfig(config)
    expect(result.ssl).toBe(true)
  })

  it('sslmode=require → ssl: { rejectUnauthorized: false }', async () => {
    const config: Config = {
      connection_string: 'postgres://user:pass@host:5432/mydb?sslmode=require',
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }
    const result = await buildPoolConfig(config)
    expect(result.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('adds proxy stream when PG_PROXY_HOST is set', async () => {
    vi.stubEnv('PG_PROXY_HOST', 'pg-proxy.example.test')

    const config: Config = {
      connection_string: 'postgres://user:pass@localhost:5432/mydb',
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }

    const result = await buildPoolConfig(config)

    expect(result.connectionString).toBe('postgres://user:pass@localhost:5432/mydb')
    expect(result.ssl).toBe(false)
    expect(typeof result.stream).toBe('function')
  })

  it('aws config → host/port/database/user/ssl/password-function PoolConfig', async () => {
    const config: Config = {
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'mydb',
      user: 'iam_user',
      schema: 'stripe',
      batch_size: 100,
      aws: { region: 'us-east-1' },
    }

    const result = await buildPoolConfig(config)

    expect(result).toEqual({
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'mydb',
      user: 'iam_user',
      password: mockPasswordFn,
      ssl: true,
    })

    expect(mockBuild).toHaveBeenCalledWith({
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'iam_user',
      region: 'us-east-1',
      roleArn: undefined,
      externalId: undefined,
    })
  })

  it('aws config with role_arn passes through', async () => {
    const config: Config = {
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'mydb',
      user: 'iam_user',
      schema: 'stripe',
      batch_size: 100,
      aws: {
        region: 'us-east-1',
        role_arn: 'arn:aws:iam::123456789012:role/MyRole',
        external_id: 'ext-123',
      },
    }

    await buildPoolConfig(config)

    expect(mockBuild).toHaveBeenCalledWith({
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'iam_user',
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      externalId: 'ext-123',
    })
  })

  it('throws when aws present but host missing', async () => {
    const config: Config = {
      port: 5432,
      database: 'mydb',
      user: 'iam_user',
      schema: 'stripe',
      batch_size: 100,
      aws: { region: 'us-east-1' },
    }

    await expect(buildPoolConfig(config)).rejects.toThrow(
      'host, database, and user are required when using AWS IAM auth'
    )
  })

  it('throws when aws present but database missing', async () => {
    const config: Config = {
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'iam_user',
      schema: 'stripe',
      batch_size: 100,
      aws: { region: 'us-east-1' },
    }

    await expect(buildPoolConfig(config)).rejects.toThrow(
      'host, database, and user are required when using AWS IAM auth'
    )
  })

  it('throws when aws present but user missing', async () => {
    const config: Config = {
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'mydb',
      schema: 'stripe',
      batch_size: 100,
      aws: { region: 'us-east-1' },
    }

    await expect(buildPoolConfig(config)).rejects.toThrow(
      'host, database, and user are required when using AWS IAM auth'
    )
  })

  it('throws when neither connection_string nor aws provided', async () => {
    const config: Config = {
      port: 5432,
      schema: 'stripe',
      batch_size: 100,
    }

    await expect(buildPoolConfig(config)).rejects.toThrow(
      'Either connection_string (or url) or aws config is required'
    )
  })
})
