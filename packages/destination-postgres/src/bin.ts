#!/usr/bin/env tsx
import connector, { spec } from './index.js'
import { runConnectorCli } from '@stripe/protocol/cli'

runConnectorCli(connector, { name: 'destination-postgres', configSchema: spec })
