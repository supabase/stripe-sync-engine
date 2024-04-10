import { ConfigType } from './types/types'
import { syncBackfill, SyncBackfillParams, syncSingleEntity } from './lib/sync'

export class StripeSyncEngine {
  private config: ConfigType

  constructor(config: ConfigType) {
    this.config = config
  }

  public getConfig(): ConfigType {
    return this.config
  }

  public syncBackfill(params?: SyncBackfillParams): void {
    syncBackfill(this.config, params)
  }

  public syncSingleEntity(stripeId: string): void {
    syncSingleEntity(stripeId, this.config)
  }
}
