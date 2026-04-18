#!/usr/bin/env node
import './bootstrap.js'
import { runMain } from 'citty'
import { createProgram } from '../cli/command.js'

const program = await createProgram()
runMain(program)
