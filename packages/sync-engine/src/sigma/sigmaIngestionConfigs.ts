import type { SigmaIngestionConfig } from './sigmaIngestion'

export const SIGMA_INGESTION_CONFIGS: Record<string, SigmaIngestionConfig> = {
  subscription_item_change_events_v2_beta: {
    sigmaTable: 'subscription_item_change_events_v2_beta',
    destinationTable: 'subscription_item_change_events_v2_beta',
    pageSize: 10_000,
    cursor: {
      version: 1,
      columns: [
        { column: 'event_timestamp', type: 'timestamp' },
        { column: 'event_type', type: 'string' },
        { column: 'subscription_item_id', type: 'string' },
      ],
    },
    upsert: {
      conflictTarget: ['_account_id', 'event_timestamp', 'event_type', 'subscription_item_id'],
      extraColumns: [
        { column: 'event_timestamp', pgType: 'timestamptz', entryKey: 'event_timestamp' },
        { column: 'event_type', pgType: 'text', entryKey: 'event_type' },
        { column: 'subscription_item_id', pgType: 'text', entryKey: 'subscription_item_id' },
      ],
    },
  },

  exchange_rates_from_usd: {
    sigmaTable: 'exchange_rates_from_usd',
    destinationTable: 'exchange_rates_from_usd',
    pageSize: 10_000,
    cursor: {
      version: 1,
      columns: [
        { column: 'date', type: 'string' },
        { column: 'sell_currency', type: 'string' },
      ],
    },
    upsert: {
      conflictTarget: ['_account_id', 'date', 'sell_currency'],
      extraColumns: [
        { column: 'date', pgType: 'date', entryKey: 'date' },
        { column: 'sell_currency', pgType: 'text', entryKey: 'sell_currency' },
      ],
    },
  },
}
