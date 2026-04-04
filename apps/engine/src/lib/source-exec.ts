import type {
  Source,
  SpecOutput,
  CheckOutput,
  DiscoverOutput,
  SetupOutput,
  TeardownOutput,
  ConfiguredCatalog,
  Message,
} from '@stripe/sync-protocol'
import { splitCmd, spawnAndStream, spawnWithStdin } from './exec-helpers.js'

/**
 * Wrap a connector CLI command as a Source.
 *
 * `cmd` may be a binary path or a space-separated command with base args,
 * e.g. `"npx @stripe/sync-source-stripe"` or `"/path/to/source-stripe"`.
 * The connector protocol subcommands (spec, check, read, etc.) are appended.
 *
 * If `$stdin` is passed to `read()`, it is piped to the subprocess stdin as
 * NDJSON — enabling live event delivery to subprocess sources.
 */
export function createSourceFromExec(cmd: string): Source {
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

    async *discover(params: { config: Record<string, unknown> }): AsyncIterable<DiscoverOutput> {
      yield* spawnAndStream<DiscoverOutput>(bin, [
        ...baseArgs,
        'discover',
        '--config',
        JSON.stringify(params.config),
      ])
    },

    read(
      params: {
        config: Record<string, unknown>
        catalog: ConfiguredCatalog
        state?: Record<string, unknown>
      },
      $stdin?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      const args = [
        ...baseArgs,
        'read',
        '--config',
        JSON.stringify(params.config),
        '--catalog',
        JSON.stringify(params.catalog),
      ]
      if (params.state) {
        args.push('--state', JSON.stringify(params.state))
      }
      if ($stdin) {
        return spawnWithStdin<unknown, Message>(bin, args, $stdin)
      }
      return spawnAndStream<Message>(bin, args)
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
