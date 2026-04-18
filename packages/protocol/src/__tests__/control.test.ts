import { describe, it, expect } from 'vitest'
import { ControlPayload, ControlMessage } from '../protocol.js'
import { destinationControlMsg } from '../helpers.js'

describe('ControlPayload', () => {
  it('parses source_config variant', () => {
    const result = ControlPayload.parse({
      control_type: 'source_config',
      source_config: { account_id: 'acct_123' },
    })
    expect(result).toEqual({
      control_type: 'source_config',
      source_config: { account_id: 'acct_123' },
    })
  })

  it('parses destination_config variant', () => {
    const result = ControlPayload.parse({
      control_type: 'destination_config',
      destination_config: { spreadsheet_id: 'abc' },
    })
    expect(result).toEqual({
      control_type: 'destination_config',
      destination_config: { spreadsheet_id: 'abc' },
    })
  })

  it('rejects unknown control_type', () => {
    expect(() => ControlPayload.parse({ control_type: 'unknown', data: {} })).toThrow()
  })
})

describe('destinationControlMsg', () => {
  it('creates a valid destination_config ControlMessage', () => {
    const msg = destinationControlMsg({ spreadsheet_id: 'sheet_123' })

    expect(msg.type).toBe('control')
    expect(msg.control.control_type).toBe('destination_config')
    expect(msg.control).toEqual({
      control_type: 'destination_config',
      destination_config: { spreadsheet_id: 'sheet_123' },
    })

    // Round-trips through the Zod schema
    expect(ControlMessage.parse(msg)).toEqual(msg)
  })

})
