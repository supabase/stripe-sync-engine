import { ConfigType } from './types/types'
import { SyncBackfill, syncBackfill, SyncBackfillParams, syncSingleEntity } from './lib/sync'
import { handleWebhookEvent } from './lib/webhooks'
import Stripe from 'stripe'
import { PostgresClient } from './database/postgres'

export class StripeSyncEngine {
  private stripe: Stripe
  private pgClient: PostgresClient

  constructor(private config: ConfigType) {
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY, {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      apiVersion: config.STRIPE_API_VERSION,
      appInfo: {
        name: 'Stripe Postgres Sync',
      },
    })
    this.pgClient = new PostgresClient({ databaseUrl: config.DATABASE_URL, schema: config.SCHEMA })
  }

  syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
    return syncBackfill(this.pgClient, this.stripe, this.config, params)
  }

  syncSingleEntity(stripeId: string) {
    return syncSingleEntity(stripeId, this.pgClient, this.stripe, this.config)
  }

  public handleWebhookEvent(event: Buffer, sig: string): Error | null {
    try {
      handleWebhookEvent(this.pgClient, this.stripe, this.config, event, sig)
      return null
    } catch (err) {
      return err
    }
  }
}
