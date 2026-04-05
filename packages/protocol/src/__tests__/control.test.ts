import { describe, it, expect } from 'vitest'
import { ControlPayload, ControlMessage } from '../protocol.js'
import { sourceControlMsg, destinationControlMsg, isControlMessage } from '../helpers.js'

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

describe('sourceControlMsg', () => {
  it('creates a valid source_config ControlMessage', () => {
    const msg = sourceControlMsg({ account_id: 'acct_123', webhook_secret: 'whsec_abc' })

    expect(msg.type).toBe('control')
    expect(msg.control.control_type).toBe('source_config')
    expect(msg.control).toEqual({
      control_type: 'source_config',
      source_config: { account_id: 'acct_123', webhook_secret: 'whsec_abc' },
    })

    // Round-trips through the Zod schema
    expect(ControlMessage.parse(msg)).toEqual(msg)
  })

  it('preserves generic type information', () => {
    const msg = sourceControlMsg({ account_id: 'acct_123' })
    // Type narrowing works after discriminant check
    if (msg.control.control_type === 'source_config') {
      expect(msg.control.source_config).toEqual({ account_id: 'acct_123' })
    }
  })

  it('passes isControlMessage guard', () => {
    const msg = sourceControlMsg({ foo: 'bar' })
    expect(isControlMessage(msg)).toBe(true)
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

  it('passes isControlMessage guard', () => {
    const msg = destinationControlMsg({ url: 'postgres://...' })
    expect(isControlMessage(msg)).toBe(true)
  })
})
