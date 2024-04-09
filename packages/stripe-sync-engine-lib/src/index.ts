import { ConfigType } from './types/types'
import { syncBackfill, SyncBackfillParams, syncSingleEntity } from './lib/sync'

export class StripeSyncEngine {
  private config: ConfigType

  constructor(config: ConfigType) {
    this.config = config
  }

  public syncBackfill(params?: SyncBackfillParams): void {
    syncBackfill(params)
  }

  public syncSingleEntity(stripeId: string): void {
    syncSingleEntity(stripeId)
  }
}
