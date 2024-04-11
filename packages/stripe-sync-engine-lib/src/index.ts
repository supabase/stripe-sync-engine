import { ConfigType } from './types/types'
import { syncBackfill, SyncBackfillParams, syncSingleEntity } from './lib/sync'
import { handleWebhookEvent } from './lib/webhooks'

export class StripeSyncEngine {
  private config: ConfigType

  constructor(config: ConfigType) {
    this.config = config
  }

  public syncBackfill(params?: SyncBackfillParams): void {
    syncBackfill(this.config, params)
  }

  public syncSingleEntity(stripeId: string): void {
    syncSingleEntity(stripeId, this.config)
  }

  public handleWebhookEvent(event: Buffer, sig: string, secret: string): void {
    handleWebhookEvent(this.config, event, sig, secret)
  }
}

export { SyncBackfillParams }
