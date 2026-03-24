#!/usr/bin/env node
import connector, { spec } from './index'
import { runConnectorCli } from '@tx-stripe/protocol/cli'

runConnectorCli(connector, { name: 'destination-postgres', configSchema: spec })
