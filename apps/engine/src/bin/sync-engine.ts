#!/usr/bin/env node
import { runMain } from 'citty'
import { createProgram } from '../cli/command.js'
import { bootstrap } from './bootstrap.js'

bootstrap()

const program = await createProgram()
runMain(program)
