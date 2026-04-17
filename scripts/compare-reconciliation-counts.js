#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SQL_FILE = path.join(SCRIPT_DIR, 'reconciliation-counts-postgres.sql')

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--source-csv') {
      args.sourceCsv = next
      i += 1
      continue
    }

    if (arg === '--db-url') {
      args.dbUrl = next
      i += 1
      continue
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function usage() {
  return [
    'Usage:',
    '  node scripts/compare-reconciliation-counts.js \\',
    '    --source-csv path/to/source-counts.csv \\',
    '    --db-url postgresql://user:pass@host:5432/db',
    '',
    'Options:',
    '  --source-csv        Required. CSV exported from the source query.',
    '  --db-url            Optional. Falls back to DATABASE_URL or POSTGRES_URL.',
  ].join('\n')
}

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
      if (row.some((value) => value.length > 0)) {
        rows.push(row)
      }
      row = []
      field = ''
      continue
    }

    if (ch === '\r') {
      continue
    }

    field += ch
  }

  row.push(field)
  if (row.some((value) => value.length > 0)) {
    rows.push(row)
  }

  return rows
}

function loadCountsFromCsvText(text, label) {
  const rows = parseCsv(text)
  if (rows.length === 0) {
    throw new Error(`${label} CSV is empty`)
  }

  const header = rows[0]
  const resourceIndex = header.indexOf('resource')
  const countIndex = header.indexOf('n')

  if (resourceIndex === -1 || countIndex === -1) {
    throw new Error(`${label} CSV must contain "resource" and "n" columns`)
  }

  const counts = new Map()
  for (const row of rows.slice(1)) {
    const resource = row[resourceIndex]?.trim()
    const rawCount = row[countIndex]?.trim()
    if (!resource) continue
    if (!rawCount) {
      throw new Error(`${label} CSV has an empty count for resource "${resource}"`)
    }
    counts.set(resource, BigInt(rawCount))
  }

  return counts
}

function runPostgresQuery({ dbUrl }) {
  const args = [dbUrl, '--no-psqlrc', '--csv', '-f', SQL_FILE]

  const result = spawnSync('psql', args, {
    encoding: 'utf8',
    env: process.env,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with status ${result.status}`)
  }

  return result.stdout
}

function formatTable(rows) {
  const headers = ['resource', 'source_n', 'postgres_n', 'delta', 'status']
  const stringRows = rows.map((row) => [
    row.resource,
    row.sourceCount ?? '',
    row.postgresCount ?? '',
    row.delta ?? '',
    row.status,
  ])

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...stringRows.map((row) => row[index].length))
  )

  const separator = widths.map((width) => '-'.repeat(width)).join('-+-')
  const formatRow = (cells) =>
    cells
      .map((cell, index) => {
        const alignRight = index > 0 && index < 4
        return alignRight ? cell.padStart(widths[index]) : cell.padEnd(widths[index])
      })
      .join(' | ')

  return [formatRow(headers), separator, ...stringRows.map(formatRow)].join('\n')
}

function buildComparisonRows(sourceCounts, postgresCounts) {
  const resources = new Set([...sourceCounts.keys(), ...postgresCounts.keys()])

  return [...resources]
    .sort((left, right) => left.localeCompare(right))
    .map((resource) => {
      const source = sourceCounts.get(resource)
      const postgres = postgresCounts.get(resource)
      const comparable = source !== undefined && postgres !== undefined
      const delta = comparable ? postgres - source : null
      const status =
        source === undefined
          ? 'missing_in_source'
          : postgres === undefined
            ? 'missing_in_postgres'
            : delta === 0n
              ? 'match'
              : 'diff'

      return {
        resource,
        sourceCount: source?.toString() ?? null,
        postgresCount: postgres?.toString() ?? null,
        delta: delta?.toString() ?? null,
        status,
      }
    })
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(usage())
    return
  }

  if (!args.sourceCsv) {
    throw new Error('Missing required argument: --source-csv')
  }

  const dbUrl = args.dbUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  if (!dbUrl) {
    throw new Error('Provide --db-url or set DATABASE_URL / POSTGRES_URL')
  }

  const sourceCsvText = readFileSync(args.sourceCsv, 'utf8')
  const sourceCounts = loadCountsFromCsvText(sourceCsvText, 'Source')

  const postgresCsvText = runPostgresQuery({
    dbUrl,
  })

  const postgresCounts = loadCountsFromCsvText(postgresCsvText, 'Postgres')
  const rows = buildComparisonRows(sourceCounts, postgresCounts)
  const mismatchCount = rows.filter((row) => row.status !== 'match').length
  const matchCount = rows.length - mismatchCount

  console.log(
    [
      `resources compared: ${rows.length}`,
      `matches: ${matchCount}`,
      `differences: ${mismatchCount}`,
    ].join('\n')
  )
  console.log('')
  console.log(formatTable(rows))

  if (mismatchCount > 0) {
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  console.error('')
  console.error(usage())
  process.exit(1)
}
