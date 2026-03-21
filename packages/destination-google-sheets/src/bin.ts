#!/usr/bin/env node
import connector, { spec } from './index'
import { runConnectorCli } from '@stripe/protocol/cli'

runConnectorCli(connector, { name: 'destination-google-sheets', configSchema: spec })
