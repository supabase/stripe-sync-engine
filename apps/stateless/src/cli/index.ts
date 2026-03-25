#!/usr/bin/env tsx

import { Command } from 'commander'
import { VERSION } from '../version.js'
import {
  resolveParams,
  setupCommand,
  teardownCommand,
  checkCommand,
  readCommand,
  writeCommand,
  runCommand,
} from './engine-commands.js'

const program = new Command()

program
  .name('sync-engine-stateless')
  .description('Stripe Sync Engine — stream data from sources to destinations')
  .version(VERSION)

function addSyncOptions(cmd: Command): Command {
  return cmd
    .option('--source <type>', 'Source connector (default: "stripe")')
    .option('--destination <type>', 'Destination connector')
    .option('--source-config <value>', 'Source config — inline JSON or file path')
    .option('--destination-config <value>', 'Destination config — inline JSON or file path')
    .option('--streams <names>', 'Comma-separated stream names')
    .option('--config <value>', 'Full config — inline JSON or file path')
    .option('--params <value>', 'Full SyncParams — inline JSON or file path (fallback)')
}

addSyncOptions(
  program
    .command('setup')
    .description('Provision external resources (webhook endpoints, tables, etc.)')
).action(async (opts) => {
  await setupCommand(resolveParams(opts))
})

addSyncOptions(program.command('teardown').description('Clean up external resources')).action(
  async (opts) => {
    await teardownCommand(resolveParams(opts))
  }
)

addSyncOptions(
  program.command('check').description('Validate source and destination connectivity')
).action(async (opts) => {
  await checkCommand(resolveParams(opts))
})

addSyncOptions(
  program.command('read').description('Read records from the source (stdout: NDJSON Messages)')
).action(async (opts) => {
  await readCommand(resolveParams(opts))
})

addSyncOptions(
  program
    .command('write')
    .description(
      'Write records to the destination (stdin: NDJSON Messages, stdout: NDJSON StateMessages)'
    )
).action(async (opts) => {
  await writeCommand(resolveParams(opts))
})

addSyncOptions(
  program
    .command('run')
    .description('Full pipeline: setup → read → write (stdout: NDJSON StateMessages)')
).action(async (opts) => {
  await runCommand(resolveParams(opts))
})

program.parse()
