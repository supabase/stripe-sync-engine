import { appendFileSync } from 'node:fs'
import { describe } from 'vitest'

/** File where CI warning annotations are collected during test runs.
 *  A post-test CI step cats this file so GitHub Actions parses the
 *  `::warning` commands without pnpm's per-package output prefix. */
const WARNINGS_FILE = '/tmp/vitest-skip-warnings.txt'

/**
 * Like `describe`, but skips the suite when any of the listed env vars
 * are missing.  In CI the skip is surfaced as a `::warning` annotation
 * that includes the suite name and the missing variable names.
 *
 * The callback receives a fully-typed object whose keys are exactly the
 * requested env-var names — all guaranteed to be `string`.
 *
 * ```ts
 * describeWithEnv('stripe e2e', ['STRIPE_API_KEY'], ({ STRIPE_API_KEY }) => {
 *   it('works', () => { … })
 * })
 * ```
 */
export function describeWithEnv<const K extends string>(
  name: string,
  envVars: K[],
  fn: (env: { [P in K]: string }) => void
): void {
  const missing = envVars.filter((k) => !process.env[k])

  if (missing.length > 0) {
    console.warn(`Skipping "${name}" -- missing env: ${missing.join(', ')}`)
    if (process.env.CI) {
      const file = callerFile()
      const loc = file ? ` file=${file},` : ''
      // Write to a temp file — pnpm prefixes stdout/stderr with the package
      // name, which prevents GitHub Actions from parsing ::warning commands.
      // A post-test CI step cats this file for clean annotation output.
      appendFileSync(
        WARNINGS_FILE,
        `::warning${loc} title=Tests Skipped::${name} -- missing env: ${missing.join(', ')}\n`
      )
    }
    describe.skip(name, () => {})
    return
  }

  const env = {} as { [P in K]: string }
  for (const k of envVars) {
    ;(env as Record<string, string>)[k] = process.env[k]!
  }
  describe(name, () => fn(env))
}

/** Walk the stack to find the file that called `describeWithEnv`. */
function callerFile(): string | undefined {
  const lines = new Error().stack?.split('\n')
  if (!lines) return undefined
  for (const line of lines.slice(1)) {
    const m = line.match(/\((.+?):\d+:\d+\)/) ?? line.match(/at (.+?):\d+:\d+/)
    if (m && !m[1].includes('test-helpers')) {
      return m[1].replace(process.cwd() + '/', '')
    }
  }
  return undefined
}
