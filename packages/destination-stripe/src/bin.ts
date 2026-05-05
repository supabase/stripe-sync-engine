#!/usr/bin/env node
import connector from './index.js'
import { configSchema } from './spec.js'
import { runConnectorCli } from '@stripe/sync-protocol/cli'

runConnectorCli(connector, { name: 'destination-stripe', configSchema })
