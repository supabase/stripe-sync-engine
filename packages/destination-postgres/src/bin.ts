#!/usr/bin/env tsx
import connector, { spec } from './index'
import { runConnectorCli } from '@stripe/protocol/cli'

runConnectorCli(connector, { name: 'destination-postgres', configSchema: spec })
