import { spawnSync } from 'node:child_process'
import type {
  Source,
  ConnectorSpecification,
  CheckResult,
  CatalogMessage,
  ConfiguredCatalog,
  Message,
} from '@stripe/sync-protocol'
import { splitCmd, spawnAndCollect, spawnAndStream, spawnWithStdin } from './lib/exec-helpers.js'

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
  let cachedSpec: ConnectorSpecification | undefined

  return {
    spec(): ConnectorSpecification {
      if (!cachedSpec) {
        // spec() is synchronous in the interface but we need to spawn.
        // The CLI outputs JSON synchronously, so we use spawnSync.
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

    async discover(params: { config: Record<string, unknown> }): Promise<CatalogMessage> {
      const stdout = await spawnAndCollect(bin, [
        ...baseArgs,
        'discover',
        '--config',
        JSON.stringify(params.config),
      ])
      return JSON.parse(stdout) as CatalogMessage
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
