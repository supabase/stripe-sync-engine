#!/usr/bin/env tsx
import connector, { spec } from './index.js'
import { runConnectorCli } from '@stripe/sync-protocol/cli'

runConnectorCli(connector, { name: 'destination-google-sheets', configSchema: spec })
