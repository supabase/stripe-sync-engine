import { createEngineFromParams, createConnectorResolver } from './lib/index.js'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import type { CliOptions } from './resolve-options.js'
import { resolveOptions } from './resolve-options.js'

export async function checkAction(opts: CliOptions) {
  const resolver = createConnectorResolver(
    {},
    {
      commandMap: parseJsonOrFile(opts.connectorsFromCommandMap) as
        | Record<string, string>
        | undefined,
      path: !opts.noConnectorsFromPath,
      npm: opts.connectorsFromNpm ?? false,
    }
  )
  const params = resolveOptions(opts)
  const engine = await createEngineFromParams(params, resolver)
  const result = await engine.check()
  console.log(JSON.stringify(result, null, 2))
}
