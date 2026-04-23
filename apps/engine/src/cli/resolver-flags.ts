import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import { createConnectorResolver, type ConnectorResolver } from '../lib/index.js'
import { defaultConnectors } from '../lib/default-connectors.js'

export interface ConnectorFlags {
  connectorsFromPath: boolean
  connectorsFromNpm: boolean
  connectorsFromCommandMap?: string
}

export function parseConnectorFlags(argv = process.argv): ConnectorFlags {
  const noPath = argv.includes('--no-connectors-from-path')
  const npm = argv.includes('--connectors-from-npm')
  let commandMap: string | undefined
  const cmdMapIdx = argv.indexOf('--connectors-from-command-map')
  if (cmdMapIdx !== -1 && cmdMapIdx + 1 < argv.length) {
    commandMap = argv[cmdMapIdx + 1]
  }
  return {
    connectorsFromPath: !noPath,
    connectorsFromNpm: npm,
    connectorsFromCommandMap: commandMap,
  }
}

export async function createResolverFromFlags(argv = process.argv): Promise<ConnectorResolver> {
  const flags = parseConnectorFlags(argv)
  return createConnectorResolver(defaultConnectors, {
    path: flags.connectorsFromPath,
    npm: flags.connectorsFromNpm,
    commandMap: parseJsonOrFile(flags.connectorsFromCommandMap) as
      | Record<string, string>
      | undefined,
  })
}
