import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  StateMessage,
  ConnectorResolver,
  Message,
  CheckResult,
} from '@stripe/sync-engine-stateless'
import { createConnectorResolver } from '@stripe/sync-engine-stateless'
import type { CredentialStore, ConfigStore } from '@stripe/stateful-sync'
import {
  StatefulSync,
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from '@stripe/stateful-sync'
import { envPrefix } from '@stripe/ts-cli'

const DEFAULT_DATA_DIR = join(homedir(), '.stripe-sync')

type ServiceOpts = {
  syncId: string
  dataDir?: string
  connectors?: ConnectorResolver
  credentials?: CredentialStore
  configs?: ConfigStore
  $stdin?: AsyncIterable<unknown>
}

function makeService(opts: ServiceOpts) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR
  const credentials = opts.credentials ?? fileCredentialStore(join(dataDir, 'credentials.json'))
  const configs = opts.configs ?? fileConfigStore(join(dataDir, 'syncs.json'))

  return new StatefulSync({
    credentials,
    configs,
    states: fileStateStore(join(dataDir, 'state.json')),
    logs: fileLogSink(join(dataDir, 'logs.ndjson')),
    connectors: opts.connectors ?? createConnectorResolver({}),
    sourceOverrides: envPrefix('SOURCE'),
    destinationOverrides: envPrefix('DESTINATION'),
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
