import { describe, it, expect } from 'vitest'
import { ControlPayload } from '../protocol.js'

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
