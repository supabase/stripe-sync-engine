/**
 * CLI wiring example: env-var credentials → SyncService → stdout NDJSON.
 *
 * Usage:
 *   STRIPE_API_KEY=sk_test_... DATABASE_URL=postgres://... node dist/examples/cli.js
 */

import { createConnectorResolver } from '@stripe/sync-protocol'
import { SyncService } from '../service'
import { envCredentialStore, flagConfigStore } from '../stores/env'
import { memoryStateStore } from '../stores/memory'
import { stderrLogSink } from '../stores/stderr'

const SYNC_ID = 'cli_sync'

async function main() {
  const config = {
    id: SYNC_ID,
    source_credential_id: 'env_source',
    destination_credential_id: 'env_destination',
    source: { type: 'stripe' },
    destination: { type: 'postgres' },
  }

  const service = new SyncService({
    credentials: envCredentialStore(),
    configs: flagConfigStore(config),
    states: memoryStateStore(),
    logs: stderrLogSink(),
    connectors: createConnectorResolver({}),
  })

  for await (const msg of service.run(SYNC_ID)) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
