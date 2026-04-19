#!/usr/bin/env bun

// Reconcile Stripe object IDs (via Sigma) against Postgres destination IDs.
// 1. Discovers tables from Postgres and fetches every ID per table
// 2. Fetches IDs from Sigma per table (skipping deleted rows where supported)
// 3. Diffs the two sets per table and prints matches, pg_only, sigma_only
//
// Zero external dependencies — uses Node 24 built-in fetch and psql for Postgres.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const SIGMA_CONCURRENCY = 16

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--stripe-api-key') {
      args.stripeApiKey = next
      i += 1
    } else if (arg === '--db-url') {
      args.dbUrl = next
      i += 1
    } else if (arg === '--output') {
      args.output = next
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new UsageError(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function usage() {
  return [
    'Reconcile Stripe Sigma IDs vs Postgres destination IDs.',
    '',
    'Usage:',
    '  node scripts/reconcile-sigma-vs-postgres.js \\',
    '    --stripe-api-key sk_live_... \\',
    '    --db-url postgresql://user:pass@host:5432/db',
    '',
    'Options:',
    '  --stripe-api-key    Required. Falls back to STRIPE_API_KEY env var.',
    '  --db-url            Optional. Falls back to DATABASE_URL or POSTGRES_URL.',
    '  --output            Optional. Report path (default: tmp/reconcile-<timestamp>.json).',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Postgres — discover tables + counts dynamically
// ---------------------------------------------------------------------------

function discoverPostgresTables(dbUrl) {
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `
  const result = spawnSync('psql', [dbUrl, '--no-psqlrc', '--csv', '-c', sql], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 1024, // 1 GB — enough for millions of short IDs
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with status ${result.status}`)
  }
  const rows = parseCsv(result.stdout)
  return rows
    .slice(1)
    .map((r) => r[0]?.trim())
    .filter(Boolean)
}

/**
 * Fetch the full set of IDs for a table from Postgres. Uses streaming so
 * very large tables (millions of rows) don't hit the spawnSync ENOBUFS limit.
 */
function fetchPostgresIds(dbUrl, table) {
  const sql = `SELECT id FROM public.${quoteIdent(table)} WHERE id IS NOT NULL;`
  return new Promise((resolve, reject) => {
    const ids = new Set()
    const stderrChunks = []
    let buffer = ''
    const child = spawn('psql', [dbUrl, '--no-psqlrc', '--csv', '-t', '-c', sql], {
      env: process.env,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (d) => stderrChunks.push(d))
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) ids.add(line)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (buffer.trim()) ids.add(buffer.trim())
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks.map((c) => Buffer.from(c)))
          .toString()
          .trim()
        reject(new Error(stderr || `psql exited with status ${code}`))
        return
      }
      resolve(ids)
    })
  })
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe table name: ${name}`)
  }
  return `"${name}"`
}

// ---------------------------------------------------------------------------
// Stripe Sigma
// ---------------------------------------------------------------------------

async function stripePost(apiKey, endpoint, params) {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(
      `Stripe POST ${endpoint} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`
    )
    err.stripeError = body.error
    throw err
  }
  return body
}

async function stripeGet(apiKey, endpoint) {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(
      `Stripe GET ${endpoint} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`
    )
  }
  return body
}

async function stripeDownload(apiKey, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe file download failed (${res.status}): ${text}`)
  }
  return res.text()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Tables whose list endpoint filters to `active = true` by default.
 *  Sigma retains inactive/archived objects that the list API doesn't surface,
 *  so we filter to active-only when querying Sigma for these tables. */
const SIGMA_TABLES_ACTIVE_ONLY = new Set(['prices', 'tax_rates'])

/**
 * Build a Sigma query that returns (id[, created]) rows for the given table.
 * Tables in `tablesWithDeletedCol` get a WHERE clause that excludes deleted
 * rows so results match what Stripe's `list` endpoints return.
 * Tables in SIGMA_TABLES_ACTIVE_ONLY get an additional `active = true` filter.
 */
function buildSigmaIdsSql(table, { withCreated, hasDeletedCol, activeOnly }) {
  const conditions = []
  if (hasDeletedCol) conditions.push('NOT COALESCE(deleted, false)')
  if (activeOnly) conditions.push('active = true')
  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  const cols = withCreated ? 'id, created' : 'id'
  return `SELECT ${cols} FROM "${table}"${where}`
}

function parseMissingTables(errorMessage) {
  const match = errorMessage.match(/tables which do not exist or are inaccessible:\s*\[([^\]]+)\]/i)
  if (!match) return null
  return match[1].split(',').map((t) => t.trim())
}

class SigmaQueryFailedError extends Error {
  constructor(queryRunId, response) {
    const errMsg = response.error?.message ?? JSON.stringify(response.error ?? null)
    super(`Sigma query failed (status=${response.status}) id=${queryRunId} error=${errMsg}`)
    this.queryRunId = queryRunId
    this.response = response
    this.errorMessage = response.error?.message
  }
}

async function pollSigmaRun(apiKey, queryRunId) {
  const start = Date.now()
  let current = await stripeGet(apiKey, `/v1/sigma/query_runs/${queryRunId}`)

  while (current.status === 'running') {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Sigma query timed out after ${POLL_TIMEOUT_MS / 1000}s: ${queryRunId}`)
    }
    await sleep(POLL_INTERVAL_MS)
    current = await stripeGet(apiKey, `/v1/sigma/query_runs/${queryRunId}`)
  }

  // Stripe's Sigma API uses "completed" in some versions and "succeeded" in others.
  if (current.status !== 'completed' && current.status !== 'succeeded') {
    throw new SigmaQueryFailedError(queryRunId, current)
  }
  return current
}

async function downloadSigmaResult(apiKey, completed) {
  const fileUrl = completed.file?.url
  const fileId = completed.file?.id ?? completed.result?.file
  if (!fileUrl && !fileId) {
    throw new Error(`Sigma query succeeded but no file found (id=${completed.id})`)
  }
  const downloadUrl = fileUrl ?? `https://files.stripe.com/v1/files/${fileId}/contents`
  return stripeDownload(apiKey, downloadUrl)
}

async function runIdsQuery(apiKey, sql, table) {
  const queryRun = await stripePost(apiKey, '/v1/sigma/query_runs', { sql })
  const completed = await pollSigmaRun(apiKey, queryRun.id)
  const csv = await downloadSigmaResult(apiKey, completed)
  const rows = parseCsv(csv)
  if (rows.length < 2) return { ids: new Set(), createdById: new Map() }
  const header = rows[0]
  const idIdx = header.indexOf('id')
  if (idIdx === -1) throw new Error(`Sigma result for ${table} missing "id" column`)
  const createdIdx = header.indexOf('created')
  const ids = new Set()
  const createdById = new Map()
  for (const r of rows.slice(1)) {
    const id = r[idIdx]?.trim()
    if (!id) continue
    ids.add(id)
    if (createdIdx !== -1) {
      const created = r[createdIdx]?.trim()
      if (created) createdById.set(id, created)
    }
  }
  return { ids, createdById }
}

function isMissingColumnError(err) {
  const msg = err.errorMessage ?? err.message ?? ''
  return /column|invalid identifier/i.test(msg)
}

/**
 * Fetch IDs (with `created` where available) for a Sigma table. Retries
 * progressively stripping columns/filters when Sigma reports they don't
 * exist on that particular table.
 */
async function fetchSigmaIds(apiKey, table, hasDeletedCol, activeOnly = false) {
  const variants = [
    { withCreated: true, hasDeletedCol, activeOnly },
    { withCreated: false, hasDeletedCol, activeOnly },
  ]
  if (hasDeletedCol) {
    variants.push({ withCreated: true, hasDeletedCol: false, activeOnly })
    variants.push({ withCreated: false, hasDeletedCol: false, activeOnly })
  }
  if (activeOnly) {
    // Also try without the active filter in case the column doesn't exist
    variants.push({ withCreated: true, hasDeletedCol: false, activeOnly: false })
    variants.push({ withCreated: false, hasDeletedCol: false, activeOnly: false })
  }
  let lastErr
  for (const variant of variants) {
    try {
      return await runIdsQuery(apiKey, buildSigmaIdsSql(table, variant), table)
    } catch (err) {
      if (!isMissingColumnError(err)) throw err
      lastErr = err
    }
  }
  throw lastErr
}

/** Try to detect a missing-table error from either POST or poll response. */
function detectMissingTables(err) {
  const msg = err.stripeError?.message ?? err.errorMessage ?? err.message
  return parseMissingTables(msg)
}

/** Stripe Sigma tables that expose a `deleted` column. Stripe Sigma doesn't
 *  let us query `information_schema`, so we maintain this list by hand based on
 *  Stripe's public data dictionary. Add entries as needed. */
const SIGMA_TABLES_WITH_DELETED = new Set([
  'accounts',
  'bank_accounts',
  'cards',
  'coupons',
  'customers',
  'discounts',
  'invoice_line_items',
  'issuing_personalization_designs',
  'plans',
  'products',
  'skus',
  'subscription_items',
  'subscriptions',
  'tax_ids',
  'terminal_readers',
])

/** Known Postgres → Sigma name aliases. Add entries as you discover more. */
const SIGMA_ALIAS = {
  invoiceitems: 'invoice_line_items',
  // NOTE: do NOT alias tax_ids → customer_tax_ids. The sync engine uses
  // /v1/tax_ids which returns account-level tax IDs, while Sigma's
  // customer_tax_ids table contains customer-scoped tax IDs (different dataset).
  billing_alerts: 'billing_meter_alerts',
}

/** Tables to skip from reconciliation entirely. These cannot be meaningfully
 *  compared because the sync engine either excludes them or the top-level API
 *  endpoint doesn't return the same scope of data as Sigma. */
const RECONCILE_SKIP = new Set([
  // Requires `customer` query param; explicitly excluded from sync engine.
  'billing_credit_balance_transactions',
  // Top-level /v1/payment_methods only returns unattached/Treasury payment methods.
  // Sigma includes customer-attached pm_, src_, and card_ objects.
  'payment_methods',
])

/** Per-table ID filters applied to Sigma results before comparison.
 *  Sigma tables sometimes include object types that the sync engine fetches
 *  via a different endpoint or that aren't available with the current API key mode. */
const SIGMA_ID_FILTERS: Record<string, (id: string) => boolean> = {
  // Sigma's "transfers" table includes payouts (po_ prefix). The sync engine
  // fetches payouts via /v1/payouts, not /v1/transfers.
  transfers: (id) => !id.startsWith('po_'),
  // Sigma includes test-mode billing meters (mtr_test_ prefix) which a
  // live-mode API key does not return from /v1/billing/meters.
  billing_meters: (id) => !id.startsWith('mtr_test_'),
}

/**
 * Run one Sigma query per table, with bounded concurrency. Isolates failures
 * (missing table, opaque query error) to the offending table only so one
 * bad table doesn't tank the whole reconcile.
 */
async function runSigmaForResources(apiKey, resources) {
  const skipped = []
  const dataByTable = new Map() // pgTable → { ids: Set<id>, createdById: Map<id, created> }
  let done = 0

  // Sigma doesn't expose information_schema, so we can't discover its tables
  // dynamically. We try each PG table name in Sigma (with known aliases) and
  // rely on Sigma's error message to tell us which are unavailable.
  const work = resources.map((pgTable) => ({
    pgTable,
    sigmaTable: SIGMA_ALIAS[pgTable] ?? pgTable,
  }))

  const aliased = work.filter((w) => w.sigmaTable !== w.pgTable)
  if (aliased.length > 0) {
    console.error(`  aliased: ${aliased.map((w) => `${w.pgTable}→${w.sigmaTable}`).join(', ')}`)
  }

  const queryable = work
  const unexpectedErrors = []

  async function runOne({ pgTable, sigmaTable }) {
    try {
      const data = await fetchSigmaIds(
        apiKey,
        sigmaTable,
        SIGMA_TABLES_WITH_DELETED.has(sigmaTable),
        SIGMA_TABLES_ACTIVE_ONLY.has(pgTable)
      )
      dataByTable.set(pgTable, data)
    } catch (err) {
      const missing = detectMissingTables(err)
      if (!missing || !missing.includes(sigmaTable)) {
        unexpectedErrors.push(`${pgTable}: ${err.message}`)
      }
      skipped.push(pgTable)
    } finally {
      done += 1
      process.stderr.write(`\r  progress: ${done}/${queryable.length}`)
    }
  }

  const queue = [...queryable]
  console.error(
    `Fetching IDs from ${queue.length} Sigma tables (concurrency=${SIGMA_CONCURRENCY})...`
  )
  await Promise.all(
    Array.from({ length: Math.min(SIGMA_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        await runOne(item)
      }
    })
  )
  process.stderr.write('\n')

  if (unexpectedErrors.length > 0) {
    console.error(`  ${unexpectedErrors.length} unexpected error(s):`)
    for (const e of unexpectedErrors) console.error(`    ${e}`)
  }

  return { dataByTable, skipped }
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      if (row.some((v) => v.length > 0)) rows.push(row)
      row = []
      field = ''
      continue
    }
    if (ch === '\r') continue
    field += ch
  }
  row.push(field)
  if (row.some((v) => v.length > 0)) rows.push(row)
  return rows
}

// ---------------------------------------------------------------------------
// Comparison + output
// ---------------------------------------------------------------------------

// We only care about IDs that exist in Sigma but are missing from Postgres.
// Rows present in Postgres but absent from Sigma are disregarded.
function diffSets(sigmaData, pgIds) {
  const common = new Set()
  const postgresMissing = []
  for (const id of sigmaData.ids) {
    if (pgIds.has(id)) {
      common.add(id)
    } else {
      postgresMissing.push({
        id,
        created: sigmaData.createdById.get(id) ?? null,
      })
    }
  }
  postgresMissing.sort((a, b) => {
    const ac = Number(a.created)
    const bc = Number(b.created)
    const aValid = Number.isFinite(ac)
    const bValid = Number.isFinite(bc)
    if (aValid && bValid) return bc - ac
    if (aValid) return -1
    if (bValid) return 1
    return 0
  })
  return { common, postgresMissing }
}

function formatCreated(raw) {
  if (!raw) return 'unknown'
  const n = Number(raw)
  // Sigma stores `created` as unix seconds for most resources. Sanity-check
  // the range so we don't mis-render a numeric column that isn't a timestamp.
  if (Number.isFinite(n) && n > 946_684_800 && n < 4_102_444_800) {
    return new Date(n * 1000).toISOString()
  }
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return String(raw)
}

function buildComparisonRows(sigmaDataByTable, postgresIdsByTable, skippedTables) {
  const skippedSet = new Set(skippedTables)
  const resources = new Set([...sigmaDataByTable.keys(), ...postgresIdsByTable.keys()])

  return [...resources]
    .sort((a, b) => a.localeCompare(b))
    .map((resource) => {
      const sigmaData = sigmaDataByTable.get(resource)
      const pgIds = postgresIdsByTable.get(resource) ?? new Set()

      if (skippedSet.has(resource) || sigmaData === undefined) {
        return {
          resource,
          sigmaCount: null,
          postgresCount: pgIds.size,
          matches: null,
          postgresMissing: null,
          missingRows: [],
          status: 'skipped_in_sigma',
        }
      }

      const { common, postgresMissing } = diffSets(sigmaData, pgIds)
      const status = postgresMissing.length === 0 ? 'match' : 'diff'

      return {
        resource,
        sigmaCount: sigmaData.ids.size,
        postgresCount: pgIds.size,
        matches: common.size,
        postgresMissing: postgresMissing.length,
        missingRows: postgresMissing,
        status,
      }
    })
}

function formatTable(rows) {
  const headers = ['resource', 'sigma', 'postgres', 'matches', 'postgres_missing', 'status']
  const stringRows = rows.map((r) => [
    r.resource,
    r.sigmaCount?.toString() ?? '-',
    r.postgresCount?.toString() ?? '-',
    r.matches?.toString() ?? '-',
    r.postgresMissing?.toString() ?? '-',
    r.status,
  ])
  const widths = headers.map((h, i) => Math.max(h.length, ...stringRows.map((r) => r[i].length)))
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')
  const fmt = (cells) =>
    cells
      .map((c, i) => {
        const right = i > 0 && i < headers.length - 1
        return right ? c.padStart(widths[i]) : c.padEnd(widths[i])
      })
      .join(' | ')
  return [fmt(headers), separator, ...stringRows.map(fmt)].join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const apiKey = args.stripeApiKey ?? process.env.STRIPE_API_KEY
  if (!apiKey) throw new UsageError('Provide --stripe-api-key or set STRIPE_API_KEY')

  const dbUrl = args.dbUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  if (!dbUrl) throw new UsageError('Provide --db-url or set DATABASE_URL / POSTGRES_URL')

  // Step 1: discover tables from Postgres
  console.error('Discovering tables from Postgres...')
  const pgTables = discoverPostgresTables(dbUrl)
  console.error(`  found ${pgTables.length} tables`)

  // Step 2: fetch IDs for every PG table (serial to avoid overloading psql)
  console.error(`Fetching IDs from Postgres (${pgTables.length} tables)...`)
  const postgresIdsByTable = new Map()
  let pgDone = 0
  for (const table of pgTables) {
    try {
      const ids = await fetchPostgresIds(dbUrl, table)
      postgresIdsByTable.set(table, ids)
    } catch (err) {
      console.error(`\n  failed to fetch IDs from ${table}: ${err.message}`)
      postgresIdsByTable.set(table, new Set())
    } finally {
      pgDone += 1
      process.stderr.write(`\r  progress: ${pgDone}/${pgTables.length}`)
    }
  }
  process.stderr.write('\n')

  // Filter out tables that can't be meaningfully reconciled
  const excludedTables = pgTables.filter((t) => RECONCILE_SKIP.has(t))
  const pgTablesToCompare = pgTables.filter((t) => !RECONCILE_SKIP.has(t))
  if (excludedTables.length > 0) {
    console.error(`  excluded from comparison: ${excludedTables.join(', ')}`)
  }

  // Step 3: fetch IDs from Sigma for comparable tables
  const { dataByTable: sigmaDataByTable, skipped } = await runSigmaForResources(
    apiKey,
    pgTablesToCompare
  )

  // Apply per-table ID filters to remove object types that the sync engine
  // fetches via a different endpoint or can't access with the current key mode.
  for (const [table, filterFn] of Object.entries(SIGMA_ID_FILTERS)) {
    const data = sigmaDataByTable.get(table)
    if (!data) continue
    const filteredIds = new Set()
    const filteredCreatedById = new Map()
    for (const id of data.ids) {
      if (filterFn(id)) {
        filteredIds.add(id)
        const created = data.createdById.get(id)
        if (created) filteredCreatedById.set(id, created)
      }
    }
    const removed = data.ids.size - filteredIds.size
    if (removed > 0) {
      console.error(`  filtered ${removed} IDs from ${table} (Sigma scope mismatch)`)
    }
    sigmaDataByTable.set(table, { ids: filteredIds, createdById: filteredCreatedById })
  }

  // Step 4: compare + print
  const rows = buildComparisonRows(sigmaDataByTable, postgresIdsByTable, [
    ...skipped,
    ...excludedTables,
  ])
  const matchCount = rows.filter((r) => r.status === 'match').length
  const diffCount = rows.filter((r) => r.status === 'diff').length
  const skippedCount = rows.filter((r) => r.status === 'skipped_in_sigma').length
  const skippedRows = rows.filter((r) => r.status === 'skipped_in_sigma')
  const diffRows = rows.filter((r) => r.status === 'diff')

  // Write detailed report to file (defaults to tmp/reconcile-<timestamp>.json)
  const outputPath =
    args.output ?? `tmp/reconcile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  {
    mkdirSync(dirname(outputPath), { recursive: true })
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        tables: pgTables.length,
        compared: matchCount + diffCount,
        matches: matchCount,
        differences: diffCount,
        skipped: skippedCount,
      },
      formatted: formatTable(rows.filter((r) => r.status !== 'skipped_in_sigma')),
      tables: rows,
    }
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`Report: ${outputPath}`)
  }

  // Console summary
  console.log('')
  console.log(
    [
      `tables in postgres: ${pgTables.length}`,
      `compared:           ${matchCount + diffCount}`,
      `matches:            ${matchCount}`,
      `differences:        ${diffCount}`,
      `skipped (no sigma): ${skippedCount}`,
    ].join('\n')
  )

  console.log('')
  console.log(formatTable(rows.filter((r) => r.status !== 'skipped_in_sigma')))

  if (diffCount > 0) process.exit(1)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  if (error instanceof UsageError) {
    console.error('')
    console.error(usage())
  }
  process.exit(1)
}
