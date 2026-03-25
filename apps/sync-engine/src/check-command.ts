import { createEngineFromParams, createConnectorResolver } from '@stripe/stateless-sync'
import { parseJsonOrFile } from '@stripe/ts-cli'
import type { CliOptions } from './resolve-options'
import { resolveOptions } from './resolve-options'

export async function checkAction(opts: CliOptions) {
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
  const engine = await createEngineFromParams(params, resolver)
  const result = await engine.check()
  console.log(JSON.stringify(result, null, 2))
}
