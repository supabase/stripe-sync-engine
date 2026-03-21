import { createEngineFromParams, createConnectorResolver } from '@stripe/stateless-sync'
import type { CliOptions } from './resolve-options'
import { resolveOptions } from './resolve-options'

const resolver = createConnectorResolver({})

export async function checkAction(opts: CliOptions) {
  const params = resolveOptions(opts)
  const engine = await createEngineFromParams(params, resolver)
  const result = await engine.check()
  console.log(JSON.stringify(result, null, 2))
}
