import { spawnSync } from 'node:child_process'
import type {
  Destination,
  ConnectorSpecification,
  CheckResult,
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'
import { splitCmd, spawnAndCollect, spawnWithStdin } from './lib/exec-helpers.js'

/**
 * Wrap a connector CLI command as a Destination.
 *
 * `cmd` may be a binary path or a space-separated command with base args,
 * e.g. `"npx @stripe/sync-destination-postgres"` or `"/path/to/destination-postgres"`.
 * The connector protocol subcommands (spec, check, write, etc.) are appended.
 */
export function createDestinationFromExec(cmd: string): Destination {
  const [bin, baseArgs] = splitCmd(cmd)
  let cachedSpec: ConnectorSpecification | undefined

  return {
    spec(): ConnectorSpecification {
      if (!cachedSpec) {
        const result = spawnSync(bin, [...baseArgs, 'spec'], { stdio: ['ignore', 'pipe', 'pipe'] })
        if (result.status !== 0) {
          throw new Error(`${cmd} spec exited with code ${result.status}: ${result.stderr}`)
        }
        cachedSpec = JSON.parse(result.stdout.toString()) as ConnectorSpecification
      }
      return cachedSpec
    },

    async check(params: { config: Record<string, unknown> }): Promise<CheckResult> {
      const stdout = await spawnAndCollect(bin, [
        ...baseArgs,
        'check',
        '--config',
        JSON.stringify(params.config),
      ])
      return JSON.parse(stdout) as CheckResult
    },

    write(
      params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> {
      return spawnWithStdin<DestinationInput, DestinationOutput>(
        bin,
        [
          ...baseArgs,
          'write',
          '--config',
          JSON.stringify(params.config),
          '--catalog',
          JSON.stringify(params.catalog),
        ],
        $stdin
      )
    },

    async setup(params: {
      config: Record<string, unknown>
      catalog: ConfiguredCatalog
    }): Promise<void> {
      try {
        await spawnAndCollect(bin, [
          ...baseArgs,
          'setup',
          '--config',
          JSON.stringify(params.config),
          '--catalog',
          JSON.stringify(params.catalog),
        ])
      } catch (err) {
        if (String(err).includes("unknown command 'setup'")) {
          console.error('setup: not applicable')
          return
        }
        throw err
      }
    },

    async teardown(params: { config: Record<string, unknown> }): Promise<void> {
      try {
        await spawnAndCollect(bin, [
          ...baseArgs,
          'teardown',
          '--config',
          JSON.stringify(params.config),
        ])
      } catch (err) {
        if (String(err).includes("unknown command 'teardown'")) {
          console.error('teardown: not applicable')
          return
        }
        throw err
      }
    },
  }
}
