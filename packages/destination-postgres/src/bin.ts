#!/usr/bin/env node
import connector, { spec } from './index.js'
import { runConnectorCli } from '@stripe/sync-protocol/cli'

runConnectorCli(connector, { name: 'destination-postgres', configSchema: spec })
