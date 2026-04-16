#!/usr/bin/env node
import { createStripeListServer } from '../server/createStripeListServer.js'

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2))
  const server = await createStripeListServer({
    port: argv.port ? Number(argv.port) : undefined,
    host: argv.host,
    postgresUrl: argv['postgres-url'],
    apiVersion: argv['api-version'],
    openApiSpecPath: argv['openapi-spec-path'],
    schema: argv.schema,
    accountCreated: argv['account-created'] ? Number(argv['account-created']) : undefined,
  })

  process.stderr.write(
    `sync-test-utils server listening at ${server.url} (postgres_mode=${server.postgresMode})\n`
  )

  await new Promise<void>((resolve) => {
    const stop = async () => {
      await server.close().catch(() => undefined)
      resolve()
    }
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())
  })
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = next
    i += 1
  }
  return parsed
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`sync-test-utils server failed: ${message}\n`)
  process.exit(1)
})
