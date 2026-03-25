'use client'

/**
 * PGlite Database Hydration Hook
 *
 * Fetches the Stripe OpenAPI spec from GitHub, generates CREATE TABLE DDL
 * in-browser using SpecParser, and loads it into a PGlite (WASM Postgres)
 * instance. No static files, no build step.
 *
 * The spec (~3 MB) is cached in sessionStorage after the first fetch.
 */

import { PGlite } from '@electric-sql/pglite'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  type ParsedResourceTable,
} from '@stripe/sync-source-stripe/browser'

type PGliteInstance = InstanceType<typeof PGlite>
type QueryResult = Awaited<ReturnType<PGliteInstance['query']>>

const STRIPE_OPENAPI_URL =
  'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json'
const SESSION_CACHE_KEY = 'stripe-explorer-schema-v1'

export interface ExplorerManifest {
  apiVersion: string
  totalTables: number
  tables: string[]
}

type DatabaseStatus = 'idle' | 'loading' | 'ready' | 'error'
type InitializedDatabase = { db: PGliteInstance; manifest: ExplorerManifest }

let sharedDatabasePromise: Promise<InitializedDatabase> | null = null

interface UsePGliteResult {
  db: PGliteInstance | null
  status: DatabaseStatus
  error: string | null
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  exec: (sql: string) => Promise<void>
  manifest: ExplorerManifest | null
}

export function usePGlite(): UsePGliteResult {
  const [db, setDb] = useState<PGliteInstance | null>(null)
  const [status, setStatus] = useState<DatabaseStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ExplorerManifest | null>(null)
  const currentPromiseRef = useRef<Promise<InitializedDatabase> | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)

    currentPromiseRef.current ??= getOrCreateDatabase()
    currentPromiseRef.current
      .then(({ db: initializedDb, manifest: initializedManifest }) => {
        if (cancelled) return
        setDb(initializedDb)
        setManifest(initializedManifest)
        setStatus('ready')
      })
      .catch((err) => {
        console.error('[PGlite] Initialization error:', err)
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown initialization error')
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const query = useCallback(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      if (status !== 'ready' || !db) throw new Error('Database not ready: ' + status)
      return db.query(sql, params)
    },
    [db, status]
  )

  const exec = useCallback(
    async (sql: string): Promise<void> => {
      if (status !== 'ready' || !db) throw new Error('Database not ready: ' + status)
      await db.exec(sql)
    },
    [db, status]
  )

  return { db, status, error, query, exec, manifest }
}

async function getOrCreateDatabase(): Promise<InitializedDatabase> {
  if (!sharedDatabasePromise) {
    sharedDatabasePromise = buildDatabase().catch((err) => {
      sharedDatabasePromise = null
      throw err
    })
  }
  return sharedDatabasePromise
}

async function buildDatabase(): Promise<InitializedDatabase> {
  // Try sessionStorage cache first (avoids re-fetching the 3 MB spec on reload)
  let sql: string
  let manifest: ExplorerManifest
  const cached =
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_CACHE_KEY) : null

  if (cached) {
    console.log('[PGlite] Using cached schema from sessionStorage')
    ;({ sql, manifest } = JSON.parse(cached) as { sql: string; manifest: ExplorerManifest })
  } else {
    console.log('[PGlite] Fetching Stripe OpenAPI spec...')
    const response = await fetch(STRIPE_OPENAPI_URL)
    if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`)
    const spec = await response.json()
    console.log('[PGlite] Parsing schema...')
    ;({ sql, manifest } = generateSchema(spec))
    try {
      sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ sql, manifest }))
    } catch {
      // sessionStorage full — continue without caching
    }
  }

  console.log(`[PGlite] Creating database (${manifest.totalTables} tables)...`)
  const db = await PGlite.create()
  await db.exec(sql)
  console.log('[PGlite] Ready')
  return { db, manifest }
}

// ---------------------------------------------------------------------------
// Schema generation — runs in the browser, no Node.js deps
// ---------------------------------------------------------------------------

function generateSchema(spec: Record<string, unknown>): {
  sql: string
  manifest: ExplorerManifest
} {
  const schemas =
    (spec as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}

  // Discover all table names from x-resourceId fields
  const allTableNames = new Set<string>()
  for (const schemaDef of Object.values(schemas)) {
    const resourceId = (schemaDef as Record<string, unknown>)['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue
    const alias = OPENAPI_RESOURCE_TABLE_ALIASES[resourceId]
    if (alias) {
      allTableNames.add(alias)
    } else {
      const normalized = resourceId.toLowerCase().replace(/\./g, '_')
      allTableNames.add(normalized.endsWith('s') ? normalized : `${normalized}s`)
    }
  }

  const parser = new SpecParser()
  const parsed = parser.parse(spec as Parameters<SpecParser['parse']>[0], {
    allowedTables: Array.from(allTableNames),
  })

  const lines: string[] = [`CREATE SCHEMA IF NOT EXISTS "stripe";`, '']
  for (const table of parsed.tables) {
    lines.push(buildTableSql('stripe', table))
    lines.push('')
  }

  const manifest: ExplorerManifest = {
    apiVersion: parsed.apiVersion,
    totalTables: parsed.tables.length,
    tables: parsed.tables.map((t) => t.tableName),
  }

  return { sql: lines.join('\n'), manifest }
}

function buildTableSql(schema: string, table: ParsedResourceTable): string {
  const qt = (s: string) => `"${s.replaceAll('"', '""')}"`

  const cols: string[] = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz NOT NULL DEFAULT now()',
    '"_account_id" text NOT NULL',
    `"id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED`,
  ]

  for (const col of table.columns) {
    const p = col.name.replace(/'/g, "''")
    const pg = scalartypeToPg(col.type)
    let expr: string
    if (col.expandableReference) {
      expr = `CASE WHEN jsonb_typeof(_raw_data->'${p}') = 'object' AND _raw_data->'${p}' ? 'id' THEN (_raw_data->'${p}'->>'id') ELSE (_raw_data->>'${p}') END`
    } else if (pg === 'jsonb') {
      expr = `(_raw_data->'${p}')::jsonb`
    } else if (pg === 'text') {
      expr = `(_raw_data->>'${p}')::text`
    } else {
      expr = `(NULLIF(_raw_data->>'${p}', ''))::${pg}`
    }
    cols.push(`${qt(col.name)} ${pg} GENERATED ALWAYS AS (${expr}) STORED`)
  }

  cols.push('PRIMARY KEY ("id")')

  return `CREATE TABLE IF NOT EXISTS ${qt(schema)}.${qt(table.tableName)} (\n  ${cols.join(',\n  ')}\n);`
}

function scalartypeToPg(type: string): string {
  switch (type) {
    case 'bigint':
      return 'bigint'
    case 'numeric':
      return 'numeric'
    case 'boolean':
      return 'boolean'
    case 'json':
      return 'jsonb'
    case 'timestamptz':
      return 'timestamptz'
    default:
      return 'text'
  }
}
