export type RdsIamConfig = {
  host: string
  port: number
  user: string
  region: string
  roleArn?: string
  externalId?: string
}

type CachedCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: Date
}

let cachedCredentials: CachedCredentials | undefined

/** Visible for testing — resets the module-level STS credential cache. */
export function _resetCredentialCache() {
  cachedCredentials = undefined
}

function isExpiringSoon(expiration: Date, bufferMs = 5 * 60 * 1000): boolean {
  return expiration.getTime() - Date.now() < bufferMs
}

async function assumeRole(
  roleArn: string,
  externalId: string | undefined,
  region: string
): Promise<CachedCredentials> {
  let STSClient: any, AssumeRoleCommand: any
  try {
    ;({ STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts'))
  } catch {
    throw new Error(
      '@aws-sdk/client-sts is required for AWS IAM auth. Install it: pnpm add @aws-sdk/client-sts'
    )
  }

  const sts = new STSClient({ region })
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'sync-engine',
    ...(externalId ? { ExternalId: externalId } : {}),
  })

  const response = await sts.send(command)
  const creds = response.Credentials
  if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
    throw new Error('STS AssumeRole returned incomplete credentials')
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration ?? new Date(Date.now() + 3600 * 1000),
  }
}

/**
 * Build a `() => Promise<string>` that generates fresh RDS IAM auth tokens.
 *
 * - If `roleArn` is provided, calls STS AssumeRole and caches credentials
 *   (refreshing 5 min before expiry).
 * - If no `roleArn`, uses ambient AWS credentials (env vars, instance profile).
 * - Token generation itself is local SigV4 signing — no network call.
 *
 * Performs an eager validation call on build to surface config errors early.
 */
export async function buildRdsIamPasswordFn(config: RdsIamConfig): Promise<() => Promise<string>> {
  let Signer: any
  try {
    ;({ Signer } = await import('@aws-sdk/rds-signer'))
  } catch {
    throw new Error(
      '@aws-sdk/rds-signer is required for AWS IAM auth. Install it: pnpm add @aws-sdk/rds-signer'
    )
  }

  // Eager validation: if roleArn is provided, assume the role now
  if (config.roleArn) {
    cachedCredentials = await assumeRole(config.roleArn, config.externalId, config.region)
  }

  return async () => {
    // Refresh STS credentials if needed
    if (config.roleArn && (!cachedCredentials || isExpiringSoon(cachedCredentials.expiration))) {
      cachedCredentials = await assumeRole(config.roleArn, config.externalId, config.region)
    }

    const signerOptions: Record<string, unknown> = {
      hostname: config.host,
      port: config.port,
      username: config.user,
      region: config.region,
    }

    if (cachedCredentials) {
      signerOptions.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }

    const signer = new Signer(signerOptions)
    return signer.getAuthToken()
  }
}
