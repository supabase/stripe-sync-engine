#!/usr/bin/env node
import { runMain } from 'citty'
import { createProgram } from './command.js'

const program = await createProgram()
runMain(program)
