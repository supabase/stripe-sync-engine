import type { StateMessage, ConnectorResolver } from '@stripe/sync-engine-stateless-cli'
import { createConnectorResolver } from '@stripe/sync-engine-stateless-cli'
import type { CredentialStore, ConfigStore } from '@stripe/stateful-sync'
import {
  SyncService,
  envCredentialStore,
  flagConfigStore,
  memoryStateStore,
  stderrLogSink,
} from '@stripe/stateful-sync'

export async function* runSync(opts: {
  syncId: string
  sourceType: string
  destinationType: string
  connectors?: ConnectorResolver
  credentials?: CredentialStore
  configs?: ConfigStore
  $stdin?: AsyncIterable<unknown>
}): AsyncGenerator<StateMessage> {
  const credentials = opts.credentials ?? envCredentialStore()
  const configs =
    opts.configs ??
    flagConfigStore({
      id: opts.syncId,
      source: { type: opts.sourceType, credential_id: 'env_source' },
      destination: { type: opts.destinationType, credential_id: 'env_destination' },
    })

  const service = new SyncService({
    credentials,
    configs,
    states: memoryStateStore(),
    logs: stderrLogSink(),
    connectors: opts.connectors ?? createConnectorResolver({}),
  })

  yield* service.run(opts.syncId, opts.$stdin)
}
