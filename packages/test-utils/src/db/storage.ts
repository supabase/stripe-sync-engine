import type pg from 'pg'
import { buildCreateTableWithSchema, runSqlAdditive } from '@stripe/sync-destination-postgres'

export const DEFAULT_STORAGE_SCHEMA = 'stripe'

export type StoredObject = {
  tableName: string
  payload: Record<string, unknown>
}

export async function ensureSchema(
  pool: pg.Pool,
  schema: string = DEFAULT_STORAGE_SCHEMA
): Promise<void> {
  const q = quoteIdentifier
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`)
  // No trigger needed; tests either use defaults or destination upsertMany.
}

export async function ensureObjectTable(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  jsonSchema?: Record<string, unknown>
): Promise<void> {
  if (jsonSchema) {
    const stmts = buildCreateTableWithSchema(schema, tableName, jsonSchema)
    for (const stmt of stmts) {
      await runSqlAdditive(pool, stmt)
    }
    return
  }

  const q = quoteIdentifier
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(tableName)} (
      "_raw_data" jsonb NOT NULL,
      "_synced_at" timestamptz NOT NULL DEFAULT now(),
      "_updated_at" timestamptz NOT NULL DEFAULT now(),
      "id" text GENERATED ALWAYS AS (("_raw_data"->>'id')::text) STORED,
      "created" bigint GENERATED ALWAYS AS (("_raw_data"->>'created')::bigint) STORED,
      PRIMARY KEY ("id")
    )
  `)
  // The fake Stripe server paginates v1 list endpoints by created/id.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${q(`${tableName}_created_id_idx`)}
    ON ${q(schema)}.${q(tableName)} ("created" DESC, "id" DESC)
  `)
}

export async function upsertObjects(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  objects: Record<string, unknown>[]
): Promise<number> {
  if (objects.length === 0) return 0
  const q = quoteIdentifier

  const values: unknown[] = []
  const placeholders: string[] = []
  for (const obj of objects) {
    values.push(JSON.stringify(obj))
    placeholders.push(`($${values.length}::jsonb)`)
  }

  await pool.query(
    `
      INSERT INTO ${q(schema)}.${q(tableName)} ("_raw_data")
      VALUES ${placeholders.join(', ')}
      ON CONFLICT ("id")
      DO UPDATE SET
        "_raw_data" = EXCLUDED."_raw_data",
        "_synced_at" = now()
    `,
    values
  )

  return objects.length
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier "${identifier}"`)
  }
  return `"${identifier}"`
}

export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return url.replace(/:[^:@]+@/, ':***@')
  }
}
