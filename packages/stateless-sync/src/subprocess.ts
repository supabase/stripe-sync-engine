import { spawn, spawnSync } from 'node:child_process'
import type {
  Source,
  Destination,
  ConnectorSpecification,
  CheckResult,
  CatalogMessage,
  Message,
  DestinationInput,
  DestinationOutput,
  ConfiguredCatalog,
} from '@stripe/protocol'
import { parseNdjsonChunks } from './ndjson'

// MARK: - Helpers

/** Spawn a process, collect all stdout, throw on non-zero exit with stderr. */
async function spawnAndCollect(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString()
        reject(new Error(`${bin} exited with code ${code}: ${stderr}`))
      } else {
        resolve(Buffer.concat(stdoutChunks).toString())
      }
    })
  })
}

/** Spawn a process and yield parsed NDJSON lines from stdout. */
async function* spawnAndStream<T>(bin: string, args: string[]): AsyncIterable<T> {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stderrChunks: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

  let exitCode: number | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      exitCode = code
      resolve()
    })
  })

  yield* parseNdjsonChunks<T>(child.stdout)
  await exitPromise

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString()
    throw new Error(`${bin} exited with code ${exitCode}: ${stderr}`)
  }
}

/** Spawn a process, pipe NDJSON to stdin, yield parsed NDJSON from stdout. */
async function* spawnWithStdin<TIn, TOut>(
  bin: string,
  args: string[],
  input: AsyncIterable<TIn>
): AsyncIterable<TOut> {
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stderrChunks: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

  let exitCode: number | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      exitCode = code
      resolve()
    })
  })

  // Pipe input to stdin in the background
  ;(async () => {
    try {
      for await (const item of input) {
        const ok = child.stdin.write(JSON.stringify(item) + '\n')
        if (!ok) {
          await new Promise<void>((resolve) => child.stdin.once('drain', resolve))
        }
      }
    } finally {
      child.stdin.end()
    }
  })()

  yield* parseNdjsonChunks<TOut>(child.stdout)
  await exitPromise

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString()
    throw new Error(`${bin} exited with code ${exitCode}: ${stderr}`)
  }
}

// MARK: - Factory functions

/**
 * Split a command string into [bin, ...baseArgs].
 * e.g. "npx @stripe/source-stripe" → ["npx", "@stripe/source-stripe"]
 * e.g. "/path/to/source-stripe"    → ["/path/to/source-stripe"]
 */
function splitCmd(cmd: string): [string, string[]] {
  const parts = cmd.trim().split(/\s+/)
  const [bin = cmd, ...baseArgs] = parts
  return [bin, baseArgs]
}

/**
 * Wrap a connector CLI command as a Source.
 *
 * `cmd` may be a binary path or a space-separated command with base args,
 * e.g. `"npx @stripe/source-stripe"` or `"/path/to/source-stripe"`.
 * The connector protocol subcommands (spec, check, read, etc.) are appended.
 */
export function spawnSource(cmd: string): Source {
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

    read(params: {
      config: Record<string, unknown>
      catalog: ConfiguredCatalog
      state?: Record<string, unknown>
    }): AsyncIterable<Message> {
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
        // Commander errors when the connector doesn't implement setup
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

/**
 * Wrap a connector CLI command as a Destination.
 *
 * `cmd` may be a binary path or a space-separated command with base args,
 * e.g. `"npx @stripe/destination-postgres"` or `"/path/to/destination-postgres"`.
 */
export function spawnDestination(cmd: string): Destination {
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
