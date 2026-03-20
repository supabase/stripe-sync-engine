import type { ConnectorResolver, StateMessage } from '@stripe/sync-protocol'
import { createConnectorResolver } from '@stripe/sync-protocol'
import {
  SyncService,
  envCredentialStore,
  flagConfigStore,
  memoryStateStore,
  stderrLogSink,
} from '@stripe/sync-service'

export async function* runSync(opts: {
  syncId: string
  sourceType: string
  destinationType: string
  connectors?: ConnectorResolver
}): AsyncGenerator<StateMessage> {
  const config = {
    id: opts.syncId,
    source_credential_id: 'env_source',
    destination_credential_id: 'env_destination',
    source: { type: opts.sourceType },
    destination: { type: opts.destinationType },
  }

  const service = new SyncService({
    credentials: envCredentialStore(),
    configs: flagConfigStore(config),
    states: memoryStateStore(),
    logs: stderrLogSink(),
    connectors: opts.connectors ?? createConnectorResolver({}),
  })

  yield* service.run(opts.syncId)
}
