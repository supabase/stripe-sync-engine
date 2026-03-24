#!/usr/bin/env node

import 'dotenv/config'
import { Command } from 'commander'
import { parseNdjsonChunks } from '@tx-stripe/stateless-sync'
import { setupSync, teardownSync, checkSync, readSync, writeSync, runSync } from './run'

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
  process.stdout.write(JSON.stringify(result) + '\n')
})

addSyncOptions(
  program.command('read').description('Read records from the source connector')
).action(async (opts) => {
  const $stdin = !process.stdin.isTTY
    ? (parseNdjsonChunks(process.stdin as AsyncIterable<Buffer>) as AsyncIterable<unknown>)
    : undefined
  for await (const msg of readSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
})

addSyncOptions(
  program.command('write').description('Write messages to the destination connector')
).action(async (opts) => {
  const $stdin = parseNdjsonChunks(process.stdin as AsyncIterable<Buffer>) as AsyncIterable<unknown>
  for await (const msg of writeSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
})

addSyncOptions(program.command('run').description('Run a full sync')).action(async (opts) => {
  const $stdin = !process.stdin.isTTY
    ? (parseNdjsonChunks(process.stdin as AsyncIterable<Buffer>) as AsyncIterable<unknown>)
    : undefined
  for await (const msg of runSync({ syncId: opts.syncId, dataDir: opts.dataDir, $stdin })) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
})

program.parse()
