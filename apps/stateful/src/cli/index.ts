#!/usr/bin/env tsx

import 'dotenv/config'
import { Command } from 'commander'
import { readStdin, writeLine } from '@stripe/sync-ts-cli/ndjson'
import { setupSync, teardownSync, checkSync, readSync, writeSync, runSync } from './run.js'

const program = new Command()

program
  .name('sync-engine-stateful')
  .description('Stripe Sync Engine — stateful sync with credential and state management')
  .version('0.1.0')

/** Shared options for all sync commands. */
function addSyncOptions(cmd: Command): Command {
  return cmd
    .option('--sync-id <id>', 'Sync ID', 'cli_sync')
    .option(
      '--data-dir <path>',
      'Data directory for credentials, syncs, state, and logs (default: ~/.stripe-sync)'
    )
}

addSyncOptions(
  program.command('setup').description('Set up source and destination connectors')
).action(async (opts) => {
  await setupSync({ syncId: opts.syncId, dataDir: opts.dataDir })
  process.stderr.write('Setup complete.\n')
})

addSyncOptions(
  program.command('teardown').description('Tear down source and destination connectors')
).action(async (opts) => {
  await teardownSync({ syncId: opts.syncId, dataDir: opts.dataDir })
  process.stderr.write('Teardown complete.\n')
})

addSyncOptions(
  program.command('check').description('Check source and destination connectivity')
).action(async (opts) => {
  const result = await checkSync({ syncId: opts.syncId, dataDir: opts.dataDir })
  writeLine(result)
})

addSyncOptions(
  program.command('read').description('Read records from the source connector')
).action(async (opts) => {
  const $stdin = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of readSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    writeLine(msg)
  }
})

addSyncOptions(
  program.command('write').description('Write messages to the destination connector')
).action(async (opts) => {
  const $stdin = readStdin()
  for await (const msg of writeSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    writeLine(msg)
  }
})

addSyncOptions(program.command('run').description('Run a full sync')).action(async (opts) => {
  const $stdin = !process.stdin.isTTY ? readStdin() : undefined
  for await (const msg of runSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    writeLine(msg)
  }
})

program.parse()
