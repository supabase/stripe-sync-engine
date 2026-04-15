import type {
  Destination,
  SpecOutput,
  CheckOutput,
  SetupOutput,
  TeardownOutput,
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'
import { withAbortOnReturn } from '@stripe/sync-protocol'
import { splitCmd, spawnAndStream, spawnWithStdin } from './exec-helpers.js'

/**
 * Wrap a connector CLI command as a Destination.
 *
 * `cmd` may be a binary path or a space-separated command with base args,
 * e.g. `"npx @stripe/sync-destination-postgres"` or `"/path/to/destination-postgres"`.
 * The connector protocol subcommands (spec, check, write, etc.) are appended.
 */
export function createDestinationFromExec(cmd: string): Destination {
  const [bin, baseArgs] = splitCmd(cmd)

  return {
    async *spec(): AsyncIterable<SpecOutput> {
      yield* spawnAndStream<SpecOutput>(bin, [...baseArgs, 'spec'])
    },

    async *check(params: { config: Record<string, unknown> }): AsyncIterable<CheckOutput> {
      yield* spawnAndStream<CheckOutput>(bin, [
        ...baseArgs,
        'check',
        '--config',
        JSON.stringify(params.config),
      ])
    },

    write(
      params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> {
      return withAbortOnReturn((signal) =>
        spawnWithStdin<DestinationInput, DestinationOutput>(
          bin,
          [
            ...baseArgs,
            'write',
            '--config',
            JSON.stringify(params.config),
            '--catalog',
            JSON.stringify(params.catalog),
          ],
          $stdin,
          signal
        )
      )
    },

    async *setup(params: {
      config: Record<string, unknown>
      catalog: ConfiguredCatalog
    }): AsyncIterable<SetupOutput> {
      try {
        yield* spawnAndStream<SetupOutput>(bin, [
          ...baseArgs,
          'setup',
          '--config',
          JSON.stringify(params.config),
          '--catalog',
          JSON.stringify(params.catalog),
        ])
      } catch (err) {
        if (/unknown command.*setup/i.test(String(err))) return
        throw err
      }
    },

    async *teardown(params: { config: Record<string, unknown> }): AsyncIterable<TeardownOutput> {
      try {
        yield* spawnAndStream<TeardownOutput>(bin, [
          ...baseArgs,
          'teardown',
          '--config',
          JSON.stringify(params.config),
        ])
      } catch (err) {
        if (/unknown command.*teardown/i.test(String(err))) return
        throw err
      }
    },
  }
}
