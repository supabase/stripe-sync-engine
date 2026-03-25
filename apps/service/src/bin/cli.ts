#!/usr/bin/env node
import 'dotenv/config'
import { runMain } from 'citty'
import { createProgram } from '../cli/main.js'

const program = await createProgram()
runMain(program)
