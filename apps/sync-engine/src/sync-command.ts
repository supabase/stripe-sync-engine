import pg from 'pg'
import { createEngineFromParams, createConnectorResolver } from '@stripe/stateless-sync'
import type { DestinationOutput } from '@stripe/stateless-sync'
import {
  createPgStateStore,
  runMigrationsFromContent,
  genericBootstrapMigrations,
} from '@stripe/store-postgres'
import { parseJsonOrFile } from '@stripe/ts-cli'
import type { CliOptions } from './resolve-options'
import { resolveOptions, getPostgresUrl, getPostgresSchema } from './resolve-options'

export async function syncAction(opts: CliOptions) {
  const resolver = createConnectorResolver(
    {},
    {
      commandMap: parseJsonOrFile(opts.connectorsFromCommandMap) as
        | Record<string, string>
        | undefined,
      path: opts.connectorsFromPath,
      npm: opts.connectorsFromNpm ?? false,
    }
  )
  const params = resolveOptions(opts)
  const destConfig = params.destination_config as Record<string, unknown>
  const useState = opts.state !== false
  const isPostgres =
    params.destination_name === 'postgres' || params.destination_name === 'destination-postgres'

  // Load state from destination Postgres if applicable
  let stateStore: Awaited<ReturnType<typeof createPgStateStore>> | undefined
  if (useState && isPostgres) {
    const pgUrl = getPostgresUrl(destConfig)
    if (pgUrl) {
      const schema = getPostgresSchema(destConfig)
      await runMigrationsFromContent(
        { databaseUrl: pgUrl, schemaName: schema },
        genericBootstrapMigrations
      )
      const pool = new pg.Pool({ connectionString: pgUrl })
      stateStore = createPgStateStore(pool, schema)

      const state = await stateStore.get('default')
      if (state) {
        console.error(`Loaded state for ${Object.keys(state).length} stream(s)`)
        params.state = state
      } else {
        console.error('No prior state found — starting fresh')
      }
    }
  }

  // Create and run the engine
  const engine = await createEngineFromParams(params, resolver)

  let stateCount = 0
  try {
    for await (const msg of engine.run()) {
      if (msg.type === 'state') {
        // Persist state checkpoint
        if (stateStore) {
          await stateStore.set('default', msg.stream, msg.data)
        }
        stateCount++
        console.error(`checkpoint: ${msg.stream}`)
      } else if (msg.type === 'log') {
        console.error(`[${msg.level}] ${msg.message}`)
      } else if (msg.type === 'error') {
        console.error(`[error:${msg.failure_type}] ${msg.message}`)
      }
    }
  } finally {
    if (stateStore) {
      await stateStore.close()
    }
  }

  console.error(`Sync complete. ${stateCount} checkpoint(s) saved.`)
}
