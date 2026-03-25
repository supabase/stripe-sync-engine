#!/usr/bin/env node
import 'dotenv/config'
import { runMain } from 'citty'
import { main } from '../cli/main.js'

runMain(main)
