import { spawn } from 'node:child_process'
import { parseNdjsonChunks } from './ndjson'

// MARK: - Helpers

/** Spawn a process, collect all stdout, throw on non-zero exit with stderr. */
export async function spawnAndCollect(bin: string, args: string[]): Promise<string> {
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
export async function* spawnAndStream<T>(bin: string, args: string[]): AsyncIterable<T> {
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
export async function* spawnWithStdin<TIn, TOut>(
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

/**
 * Split a command string into [bin, ...baseArgs].
 * e.g. "npx @tx-stripe/source-stripe" → ["npx", "@tx-stripe/source-stripe"]
 * e.g. "/path/to/source-stripe"    → ["/path/to/source-stripe"]
 */
export function splitCmd(cmd: string): [string, string[]] {
  const parts = cmd.trim().split(/\s+/)
  const [bin = cmd, ...baseArgs] = parts
  return [bin, baseArgs]
}
