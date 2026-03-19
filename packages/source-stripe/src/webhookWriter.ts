/**
 * Interface capturing the write operations that StripeSyncWebhook needs.
 * This is a local copy of the DestinationWriter interface from @stripe/destination-postgres,
 * kept here so that source-stripe's library code has zero runtime dependency on any destination.
 */
export interface WebhookWriter {
  // Core data writes
  upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(
    entries: T[],
    table: string,
    accountId: string,
    syncTimestamp?: string
  ): Promise<T[]>

  delete(table: string, id: string): Promise<boolean>

  // Schema introspection
  columnExists(table: string, column: string): Promise<boolean>

  // Entitlement cleanup
  deleteRemovedActiveEntitlements(
    customerId: string,
    currentActiveEntitlementIds: string[]
  ): Promise<{ rowCount: number }>

  // Raw query escape hatch (for managed webhook operations)
  query(
    text: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: any[]
  ): Promise<{ rows: any[]; rowCount: number | null }> // eslint-disable-line @typescript-eslint/no-explicit-any

  // Advisory lock (for webhook creation)
  withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}
