import type { Logger, ProcessNextResult, ResourceConfig } from '../types'
import { parseCsvObjects, runSigmaQueryAndDownloadCsv } from './sigmaApi'
import { SIGMA_INGESTION_CONFIGS } from './sigmaIngestionConfigs'
import {
  buildSigmaQuery,
  defaultSigmaRowToEntry,
  sigmaCursorFromEntry,
  type SigmaIngestionConfig,
} from './sigmaIngestion'

/**
 * Interface capturing the write/read operations that SigmaSyncProcessor uses on the destination.
 */
export interface SigmaDestinationWriter {
  query(
    text: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: any[]
  ): Promise<{ rows: any[]; rowCount: number | null }> // eslint-disable-line @typescript-eslint/no-explicit-any

  upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(
    entries: T[],
    table: string,
    accountId: string,
    syncTimestamp?: string,
    upsertOptions?: SigmaIngestionConfig['upsert'],
    schemaOverride?: string
  ): Promise<T[]>

  completeObjectSync(accountId: string, runStartedAt: Date, object: string): Promise<void>

  incrementObjectProgress(
    accountId: string,
    runStartedAt: Date,
    object: string,
    count: number
  ): Promise<number>

  updateObjectCursor(
    accountId: string,
    runStartedAt: Date,
    object: string,
    cursor: string | null
  ): Promise<void>
}

export type SigmaSyncProcessorConfig = {
  stripeSecretKey: string
  enableSigma?: boolean
  sigmaPageSizeOverride?: number
  sigmaSchemaName?: string
  logger?: Logger
}

/**
 * Handles all Sigma-specific sync logic:
 * - Building the sigma portion of the resource registry
 * - Fetching a single Sigma page (query + CSV parse + upsert)
 * - Resolving fallback cursors from destination tables
 * - Utility helpers (isSigmaResource, getSupportedSigmaObjects)
 */
export class SigmaSyncProcessor {
  private readonly writer: SigmaDestinationWriter
  private readonly config: SigmaSyncProcessorConfig

  get sigmaSchemaName(): string {
    return this.config.sigmaSchemaName ?? 'sigma'
  }

  constructor(writer: SigmaDestinationWriter, config: SigmaSyncProcessorConfig) {
    this.writer = writer
    this.config = config
  }

  /**
   * Build the sigma portion of the resource registry.
   * Returns entries keyed by sigma table name with order starting after `maxCoreOrder`.
   */
  buildSigmaRegistryEntries(maxCoreOrder: number): Record<string, ResourceConfig> {
    const sigmaOverrideRaw = this.config.sigmaPageSizeOverride
    const sigmaOverride =
      typeof sigmaOverrideRaw === 'number' &&
      Number.isFinite(sigmaOverrideRaw) &&
      sigmaOverrideRaw > 0
        ? Math.floor(sigmaOverrideRaw)
        : undefined

    // TODO: Dedupe sigma tables that overlap with core Stripe objects (e.g. subscription_schedules).
    // Currently we just let core take precedence, but ideally sigma configs should exclude
    // tables that are already handled by the core Stripe API integration.
    return Object.fromEntries(
      Object.entries(SIGMA_INGESTION_CONFIGS).map(([key, sigmaConfig], idx) => {
        const pageSize = sigmaOverride
          ? Math.min(sigmaConfig.pageSize, sigmaOverride)
          : sigmaConfig.pageSize
        return [
          key,
          {
            order: maxCoreOrder + 1 + idx,
            tableName: sigmaConfig.destinationTable,
            supportsCreatedFilter: false,
            sigma: { ...sigmaConfig, pageSize },
          },
        ]
      })
    )
  }

  /**
   * Check whether a resource exists in the sigma registry.
   */
  isSigmaResource(sigmaRegistry: Record<string, ResourceConfig>, object: string): boolean {
    return object in sigmaRegistry
  }

  /**
   * Get the list of Sigma-backed object types that can be synced.
   * Only returns sigma objects when enableSigma is true.
   */
  getSupportedSigmaObjects(sigmaRegistry: Record<string, ResourceConfig>): string[] {
    if (!this.config.enableSigma) {
      return []
    }

    return Object.entries(sigmaRegistry)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key)
  }

  /**
   * Fetch the latest cursor from the destination table when no run cursor exists.
   * Queries the sigma schema for the max cursor column values.
   */
  async getSigmaFallbackCursorFromDestination(
    accountId: string,
    sigmaConfig: SigmaIngestionConfig
  ): Promise<string | null> {
    const sigmaSchema = this.sigmaSchemaName
    const cursorCols = sigmaConfig.cursor.columns
    const selectCols = cursorCols.map((c) => `"${c.column}"`).join(', ')
    const orderBy = cursorCols.map((c) => `"${c.column}" DESC`).join(', ')

    const result = await this.writer.query(
      `SELECT ${selectCols}
       FROM "${sigmaSchema}"."${sigmaConfig.destinationTable}"
       WHERE "_account_id" = $1
       ORDER BY ${orderBy}
       LIMIT 1`,
      [accountId]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0] as Record<string, unknown>
    const entryForCursor: Record<string, unknown> = {}
    for (const c of cursorCols) {
      const v = row[c.column]
      if (v == null) {
        throw new Error(
          `Sigma fallback cursor query returned null for ${sigmaConfig.destinationTable}.${c.column}`
        )
      }
      if (c.type === 'timestamp') {
        const d = v instanceof Date ? v : new Date(String(v))
        if (Number.isNaN(d.getTime())) {
          throw new Error(
            `Sigma fallback cursor query returned invalid timestamp for ${sigmaConfig.destinationTable}.${c.column}: ${String(
              v
            )}`
          )
        }
        entryForCursor[c.column] = d.toISOString()
      } else {
        entryForCursor[c.column] = String(v)
      }
    }

    return sigmaCursorFromEntry(sigmaConfig, entryForCursor)
  }

  /**
   * Fetch one page of Sigma data, upsert to Postgres, and advance the cursor.
   */
  async fetchOneSigmaPage(
    accountId: string,
    resourceName: string,
    runStartedAt: Date,
    cursor: string | null,
    sigmaConfig: SigmaIngestionConfig
  ): Promise<ProcessNextResult> {
    if (!this.config.stripeSecretKey) {
      throw new Error('Sigma sync requested but stripeSecretKey is not configured.')
    }
    if (resourceName !== sigmaConfig.destinationTable) {
      throw new Error(
        `Sigma sync config mismatch: resourceName=${resourceName} destinationTable=${sigmaConfig.destinationTable}`
      )
    }

    const effectiveCursor =
      cursor ?? (await this.getSigmaFallbackCursorFromDestination(accountId, sigmaConfig))
    const sigmaSql = buildSigmaQuery(sigmaConfig, effectiveCursor)

    this.config.logger?.info(
      { object: resourceName, pageSize: sigmaConfig.pageSize, hasCursor: Boolean(effectiveCursor) },
      'Sigma sync: running query'
    )

    const { queryRunId, fileId, csv } = await runSigmaQueryAndDownloadCsv({
      apiKey: this.config.stripeSecretKey,
      sql: sigmaSql,
      logger: this.config.logger,
    })

    const rows = parseCsvObjects(csv)
    if (rows.length === 0) {
      await this.writer.completeObjectSync(accountId, runStartedAt, resourceName)
      return { processed: 0, hasMore: false, runStartedAt }
    }

    const entries: Array<Record<string, unknown>> = rows.map((row) =>
      defaultSigmaRowToEntry(sigmaConfig, row)
    )

    this.config.logger?.info(
      { object: resourceName, rows: entries.length, queryRunId, fileId },
      'Sigma sync: upserting rows'
    )

    await this.writer.upsertManyWithTimestampProtection(
      entries,
      resourceName,
      accountId,
      undefined,
      sigmaConfig.upsert,
      this.sigmaSchemaName
    )

    await this.writer.incrementObjectProgress(accountId, runStartedAt, resourceName, entries.length)

    const newCursor = sigmaCursorFromEntry(sigmaConfig, entries[entries.length - 1]!)
    await this.writer.updateObjectCursor(accountId, runStartedAt, resourceName, newCursor)

    const hasMore = rows.length === sigmaConfig.pageSize
    if (!hasMore) {
      await this.writer.completeObjectSync(accountId, runStartedAt, resourceName)
    }

    return { processed: entries.length, hasMore, runStartedAt }
  }
}
