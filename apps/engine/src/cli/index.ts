#!/usr/bin/env node
import { assertUseEnvProxy } from '@stripe/sync-ts-cli/env-proxy'
import { runMain } from 'citty'
import { createProgram } from './command.js'

assertUseEnvProxy()

const program = await createProgram()
runMain(program)
