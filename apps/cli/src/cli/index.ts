#!/usr/bin/env node

import { Command } from 'commander'
import { VERSION } from '../version'
import {
  parseParams,
  setupCommand,
  teardownCommand,
  checkCommand,
  readCommand,
  writeCommand,
  runCommand,
} from './engine-commands'

const program = new Command()

program
  .name('sync-engine')
  .description('Stripe Sync Engine — stream data from sources to destinations')
  .version(VERSION)

program
  .command('setup')
  .description('Provision external resources (webhook endpoints, tables, etc.)')
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await setupCommand(parseParams(opts.params))
  })

program
  .command('teardown')
  .description('Clean up external resources')
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await teardownCommand(parseParams(opts.params))
  })

program
  .command('check')
  .description('Validate source and destination connectivity')
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await checkCommand(parseParams(opts.params))
  })

program
  .command('read')
  .description('Read records from the source (stdout: NDJSON Messages)')
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await readCommand(parseParams(opts.params))
  })

program
  .command('write')
  .description(
    'Write records to the destination (stdin: NDJSON Messages, stdout: NDJSON StateMessages)'
  )
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await writeCommand(parseParams(opts.params))
  })

program
  .command('run')
  .description('Full pipeline: setup → read → write (stdout: NDJSON StateMessages)')
  .requiredOption('--params <json>', 'SyncParams as JSON')
  .action(async (opts) => {
    await runCommand(parseParams(opts.params))
  })

program.parse()
