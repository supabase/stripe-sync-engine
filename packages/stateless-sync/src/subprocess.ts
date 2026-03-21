import { spawn } from 'node:child_process'
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

/** Wrap a connector CLI binary as a Source. */
export function spawnSource(bin: string): Source {
  let cachedSpec: ConnectorSpecification | undefined

  return {
    spec(): ConnectorSpecification {
      if (!cachedSpec) {
        // spec() is synchronous in the interface but we need to spawn.
        // The CLI outputs JSON synchronously, so we use spawnSync.
        const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
        const result = spawnSync(bin, ['spec'], { stdio: ['ignore', 'pipe', 'pipe'] })
        if (result.status !== 0) {
          throw new Error(`${bin} spec exited with code ${result.status}: ${result.stderr}`)
        }
        cachedSpec = JSON.parse(result.stdout.toString()) as ConnectorSpecification
      }
      return cachedSpec
    },

    async check(params: { config: Record<string, unknown> }): Promise<CheckResult> {
      const stdout = await spawnAndCollect(bin, [
        'check',
        '--config',
        JSON.stringify(params.config),
      ])
      return JSON.parse(stdout) as CheckResult
    },

    async discover(params: { config: Record<string, unknown> }): Promise<CatalogMessage> {
      const stdout = await spawnAndCollect(bin, [
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
        await spawnAndCollect(bin, ['teardown', '--config', JSON.stringify(params.config)])
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

/** Wrap a connector CLI binary as a Destination. */
export function spawnDestination(bin: string): Destination {
  let cachedSpec: ConnectorSpecification | undefined

  return {
    spec(): ConnectorSpecification {
      if (!cachedSpec) {
        const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
        const result = spawnSync(bin, ['spec'], { stdio: ['ignore', 'pipe', 'pipe'] })
        if (result.status !== 0) {
          throw new Error(`${bin} spec exited with code ${result.status}: ${result.stderr}`)
        }
        cachedSpec = JSON.parse(result.stdout.toString()) as ConnectorSpecification
      }
      return cachedSpec
    },

    async check(params: { config: Record<string, unknown> }): Promise<CheckResult> {
      const stdout = await spawnAndCollect(bin, [
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
        await spawnAndCollect(bin, ['teardown', '--config', JSON.stringify(params.config)])
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
