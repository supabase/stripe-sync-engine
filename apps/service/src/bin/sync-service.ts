#!/usr/bin/env node
import 'dotenv/config'
import { assertUseEnvProxy } from '@stripe/sync-ts-cli/env-proxy'
import { runMain } from 'citty'
import { createProgram } from '../cli.js'

assertUseEnvProxy()

const program = await createProgram()
runMain(program)
