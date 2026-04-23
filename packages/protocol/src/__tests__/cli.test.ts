import { describe, expect, it } from 'vitest'
import { createConnectorCli } from '../cli.js'
import type {
  Source,
  Destination,
  ConnectorSpecification,
  ConnectionStatusPayload,
} from '../protocol.js'

const mockSpec: ConnectorSpecification = {
  config: { type: 'object', properties: { api_key: { type: 'string' } } },
}

const mockSource: Source = {
  spec: () => mockSpec,
  check: async () => ({ status: 'succeeded' }) as ConnectionStatusPayload,
  discover: async () => ({ type: 'catalog', streams: [] }),
  async *read() {
    yield {
      type: 'record',
      stream: 'test',
      data: { id: '1' },
      emitted_at: new Date().toISOString(),
    }
  },
}

const mockSourceWithSetup: Source = {
  ...mockSource,
  setup: async () => {},
  teardown: async () => {},
}

const mockDestination: Destination = {
  spec: () => mockSpec,
  check: async () => ({ status: 'succeeded' }) as ConnectionStatusPayload,
  async *write(_params, $stdin) {
    for await (const msg of $stdin) {
      if (msg.type === 'source_state') yield msg
    }
  },
}

const mockDestinationWithSetup: Destination = {
  ...mockDestination,
  setup: async () => {},
  teardown: async () => {},
}

function commandNames(program: ReturnType<typeof createConnectorCli>): string[] {
  return Object.keys(program.subCommands ?? {})
}

describe('createConnectorCli', () => {
  describe('source', () => {
    it('registers spec, check, discover, read', () => {
      const program = createConnectorCli(mockSource)
      const names = commandNames(program)
      expect(names).toContain('spec')
      expect(names).toContain('check')
      expect(names).toContain('discover')
      expect(names).toContain('read')
    })

    it('does not register write', () => {
      const program = createConnectorCli(mockSource)
      expect(commandNames(program)).not.toContain('write')
    })

    it('does not register setup/teardown when not present', () => {
      const program = createConnectorCli(mockSource)
      expect(commandNames(program)).not.toContain('setup')
      expect(commandNames(program)).not.toContain('teardown')
    })

    it('registers setup/teardown when present', () => {
      const program = createConnectorCli(mockSourceWithSetup)
      const names = commandNames(program)
      expect(names).toContain('setup')
      expect(names).toContain('teardown')
    })
  })

  describe('destination', () => {
    it('registers spec, check, write', () => {
      const program = createConnectorCli(mockDestination)
      const names = commandNames(program)
      expect(names).toContain('spec')
      expect(names).toContain('check')
      expect(names).toContain('write')
    })

    it('does not register discover or read', () => {
      const program = createConnectorCli(mockDestination)
      const names = commandNames(program)
      expect(names).not.toContain('discover')
      expect(names).not.toContain('read')
    })

    it('does not register setup/teardown when not present', () => {
      const program = createConnectorCli(mockDestination)
      expect(commandNames(program)).not.toContain('setup')
      expect(commandNames(program)).not.toContain('teardown')
    })

    it('registers setup/teardown when present', () => {
      const program = createConnectorCli(mockDestinationWithSetup)
      const names = commandNames(program)
      expect(names).toContain('setup')
      expect(names).toContain('teardown')
    })
  })

  it('sets program name from opts', () => {
    const program = createConnectorCli(mockSource, { name: 'my-source' })
    expect(program.meta?.name).toBe('my-source')
  })
})
