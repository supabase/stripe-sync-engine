import type {
  StateMessage,
  ConnectorResolver,
  Message,
  CheckResult,
} from '@stripe/sync-engine-stateless-cli'
import { createConnectorResolver } from '@stripe/sync-engine-stateless-cli'
import type { CredentialStore, ConfigStore } from '@stripe/stateful-sync'
import {
  SyncService,
  envCredentialStore,
  flagConfigStore,
  memoryStateStore,
  stderrLogSink,
} from '@stripe/stateful-sync'

type ServiceOpts = {
  syncId: string
  sourceType: string
  destinationType: string
  connectors?: ConnectorResolver
  credentials?: CredentialStore
  configs?: ConfigStore
  $stdin?: AsyncIterable<unknown>
}

function makeService(opts: ServiceOpts) {
  const credentials = opts.credentials ?? envCredentialStore()
  const configs =
    opts.configs ??
    flagConfigStore({
      id: opts.syncId,
      source: { type: opts.sourceType, credential_id: 'env_source' },
      destination: { type: opts.destinationType, credential_id: 'env_destination' },
    })

  return new SyncService({
    credentials,
    configs,
    states: memoryStateStore(),
    logs: stderrLogSink(),
    connectors: opts.connectors ?? createConnectorResolver({}),
  })
}

export async function setupSync(opts: ServiceOpts): Promise<void> {
  await makeService(opts).setup(opts.syncId)
}

export async function teardownSync(opts: ServiceOpts): Promise<void> {
  await makeService(opts).teardown(opts.syncId)
}

export async function checkSync(
  opts: ServiceOpts
): Promise<{ source: CheckResult; destination: CheckResult }> {
  return makeService(opts).check(opts.syncId)
}

export async function* readSync(opts: ServiceOpts): AsyncGenerator<Message> {
  yield* makeService(opts).read(opts.syncId, opts.$stdin) as AsyncIterable<Message>
}

export async function* writeSync(opts: ServiceOpts): AsyncGenerator<StateMessage> {
  if (!opts.$stdin) throw new Error('$stdin required for write')
  yield* makeService(opts).write(opts.syncId, opts.$stdin as AsyncIterable<Message>)
}

export async function* runSync(opts: ServiceOpts): AsyncGenerator<StateMessage> {
  yield* makeService(opts).run(opts.syncId, opts.$stdin)
}
