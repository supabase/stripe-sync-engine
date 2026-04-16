import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn()
const mockGetAuthToken = vi.fn()

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({ send: mockSend })),
  AssumeRoleCommand: vi.fn((params: any) => ({ input: params })),
}))

vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: vi.fn(() => ({ getAuthToken: mockGetAuthToken })),
}))

import { buildRdsIamPasswordFn, _resetCredentialCache } from './aws.js'
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'
import { Signer } from '@aws-sdk/rds-signer'

const BASE_CONFIG = {
  host: 'mydb.us-east-1.rds.amazonaws.com',
  port: 5432,
  user: 'iam_user',
  region: 'us-east-1',
}

const MOCK_CREDS = {
  Credentials: {
    AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SessionToken: 'FwoGZX...token',
    Expiration: new Date(Date.now() + 3600 * 1000),
  },
}

describe('buildRdsIamPasswordFn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCredentialCache()
    mockGetAuthToken.mockResolvedValue('rds-auth-token-abc123')
  })

  it('returns a password callback that produces an RDS auth token', async () => {
    const passwordFn = await buildRdsIamPasswordFn(BASE_CONFIG)
    const token = await passwordFn()

    expect(token).toBe('rds-auth-token-abc123')
    expect(Signer).toHaveBeenCalledWith({
      hostname: BASE_CONFIG.host,
      port: BASE_CONFIG.port,
      username: BASE_CONFIG.user,
      region: BASE_CONFIG.region,
    })
  })

  it('calls STS AssumeRole when roleArn is provided', async () => {
    mockSend.mockResolvedValue(MOCK_CREDS)

    const passwordFn = await buildRdsIamPasswordFn({
      ...BASE_CONFIG,
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
    })

    // Eager validation call during build
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(AssumeRoleCommand).toHaveBeenCalledWith({
      RoleArn: 'arn:aws:iam::123456789012:role/MyRole',
      RoleSessionName: 'sync-engine',
    })

    const token = await passwordFn()
    expect(token).toBe('rds-auth-token-abc123')

    // Signer gets the assumed credentials
    expect(Signer).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: MOCK_CREDS.Credentials.AccessKeyId,
          secretAccessKey: MOCK_CREDS.Credentials.SecretAccessKey,
          sessionToken: MOCK_CREDS.Credentials.SessionToken,
        },
      })
    )
  })

  it('caches STS credentials across multiple calls', async () => {
    mockSend.mockResolvedValue(MOCK_CREDS)

    const passwordFn = await buildRdsIamPasswordFn({
      ...BASE_CONFIG,
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
    })

    // 1 call from eager validation
    expect(mockSend).toHaveBeenCalledTimes(1)

    await passwordFn()
    await passwordFn()
    await passwordFn()

    // Still only 1 call — credentials are cached
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('skips STS when no roleArn (ambient creds)', async () => {
    const passwordFn = await buildRdsIamPasswordFn(BASE_CONFIG)

    expect(mockSend).not.toHaveBeenCalled()
    expect(STSClient).not.toHaveBeenCalled()

    const token = await passwordFn()
    expect(token).toBe('rds-auth-token-abc123')

    // Signer should NOT have credentials property (uses ambient)
    expect(Signer).toHaveBeenCalledWith({
      hostname: BASE_CONFIG.host,
      port: BASE_CONFIG.port,
      username: BASE_CONFIG.user,
      region: BASE_CONFIG.region,
    })
  })

  it('passes externalId through to AssumeRoleCommand', async () => {
    mockSend.mockResolvedValue(MOCK_CREDS)

    await buildRdsIamPasswordFn({
      ...BASE_CONFIG,
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      externalId: 'ext-123',
    })

    expect(AssumeRoleCommand).toHaveBeenCalledWith({
      RoleArn: 'arn:aws:iam::123456789012:role/MyRole',
      RoleSessionName: 'sync-engine',
      ExternalId: 'ext-123',
    })
  })

  it('refreshes STS credentials when near expiry', async () => {
    // First call: return credentials expiring very soon (within 5min buffer)
    mockSend.mockResolvedValueOnce({
      Credentials: {
        ...MOCK_CREDS.Credentials,
        Expiration: new Date(Date.now() + 60 * 1000), // 1 minute from now
      },
    })

    // Second call: fresh credentials
    mockSend.mockResolvedValueOnce(MOCK_CREDS)

    const passwordFn = await buildRdsIamPasswordFn({
      ...BASE_CONFIG,
      roleArn: 'arn:aws:iam::123456789012:role/MyRole',
    })

    // 1 eager + 1 refresh (because cached creds are expiring soon)
    await passwordFn()
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})
