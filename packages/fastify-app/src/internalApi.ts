import type Stripe from 'stripe'
import type { ConnectionOptions } from 'node:tls'
import type { PoolConfig } from 'pg'
import { StripeSync, runMigrations } from '@stripe/sync-engine'
import { logger } from './logger'
import { getServerConfig } from './utils/config'

export type MerchantConfig = {
  databaseUrl: string
  stripeSecretKey: string
  schemaName: string
}

export type SetupRequestBody = {
  merchantId: string
  merchantConfig: MerchantConfig
}

export type WebhookRequestBody = SetupRequestBody & {
  event: Stripe.Event
}

export const merchantConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['databaseUrl', 'stripeSecretKey', 'schemaName'],
  properties: {
    databaseUrl: { type: 'string', minLength: 1 },
    stripeSecretKey: { type: 'string', minLength: 1 },
    schemaName: { type: 'string', minLength: 1 },
  },
} as const

export const setupBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId', 'merchantConfig'],
  properties: {
    merchantId: { type: 'string', minLength: 1 },
    merchantConfig: merchantConfigSchema,
  },
} as const

export const webhookBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId', 'merchantConfig', 'event'],
  properties: {
    merchantId: { type: 'string', minLength: 1 },
    merchantConfig: merchantConfigSchema,
    event: {
      type: 'object',
    },
  },
} as const

function buildPoolConfig(
  databaseUrl: string,
  maxPostgresConnections: number,
  sslConnectionOptions?: ConnectionOptions
): PoolConfig {
  return {
    connectionString: databaseUrl,
    keepAlive: true,
    max: maxPostgresConnections,
    ssl: sslConnectionOptions,
  }
}

export async function runSetup({ merchantId, merchantConfig }: SetupRequestBody): Promise<void> {
  const config = getServerConfig()

  logger.info({ merchantId, schemaName: merchantConfig.schemaName }, 'Running setup migrations')

  await runMigrations({
    databaseUrl: merchantConfig.databaseUrl,
    schemaName: merchantConfig.schemaName,
    logger,
    ssl: config.sslConnectionOptions,
  })
}

export async function withStripeSync<T>(
  { merchantId, merchantConfig }: SetupRequestBody,
  handler: (stripeSync: StripeSync) => Promise<T>
): Promise<T> {
  const config = getServerConfig()
  const stripeSync = await StripeSync.create({
    stripeSecretKey: merchantConfig.stripeSecretKey,
    stripeAccountId: merchantId,
    schemaName: merchantConfig.schemaName,
    logger,
    poolConfig: buildPoolConfig(
      merchantConfig.databaseUrl,
      config.maxPostgresConnections,
      config.sslConnectionOptions
    ),
  })

  try {
    return await handler(stripeSync)
  } finally {
    await stripeSync.close()
  }
}
