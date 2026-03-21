export type Migration = {
  name: string
  sql: string
}

// Each migration file exports a raw SQL string.
// The name is derived from the filename here — single source of truth.
import m0000 from './0000_bootstrap'
import m0001 from './0001_stripe_metadata'
import m0002 from './0002_sync_state'
import m0003 from './0003_drop_unused_metadata'

function m(name: string, sql: string): Migration {
  return { name: `${name}.sql`, sql }
}

export const migrations: Migration[] = [
  m('0000_bootstrap', m0000),
  m('0001_stripe_metadata', m0001),
  m('0002_sync_state', m0002),
  m('0003_drop_unused_metadata', m0003),
]

/** Generic bootstrap migrations (trigger functions + sync state table). */
export const genericBootstrapMigrations: Migration[] = [migrations[0]!, migrations[2]!]
