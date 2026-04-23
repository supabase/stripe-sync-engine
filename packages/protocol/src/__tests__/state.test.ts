import { describe, it, expect } from 'vitest'
import type { SourceStateMessage } from '../protocol.js'
import { SourceState, StatePayload, StreamStatePayload, GlobalStatePayload } from '../protocol.js'
import { stateData } from '../helpers.js'

describe('SourceState', () => {
  it('parses a full SourceState', () => {
    expect(SourceState.parse({ streams: { orders: { cursor: 1 } }, global: {} })).toEqual({
      streams: { orders: { cursor: 1 } },
      global: {},
    })
  })

  it('requires both fields', () => {
    expect(() => SourceState.parse({ streams: {} })).toThrow()
  })
})

describe('StreamStatePayload', () => {
  it('parses explicit stream state', () => {
    const result = StreamStatePayload.parse({
      state_type: 'stream',
      stream: 'orders',
      data: { cursor: 1 },
    })
    expect(result).toEqual({
      state_type: 'stream',
      stream: 'orders',
      data: { cursor: 1 },
    })
  })

  it('defaults state_type to stream when omitted', () => {
    const result = StreamStatePayload.parse({
      stream: 'orders',
      data: { cursor: 1 },
    })
    expect(result.state_type).toBe('stream')
  })
})

describe('GlobalStatePayload', () => {
  it('parses global state', () => {
    const result = GlobalStatePayload.parse({
      state_type: 'global',
      data: { events_cursor: 'evt_1' },
    })
    expect(result).toEqual({
      state_type: 'global',
      data: { events_cursor: 'evt_1' },
    })
  })
})

describe('StatePayload backward compat', () => {
  it('parses old format (no state_type) as stream', () => {
    const result = StatePayload.parse({
      stream: 'orders',
      data: { cursor: 1 },
    })
    expect(result).toEqual({
      state_type: 'stream',
      stream: 'orders',
      data: { cursor: 1 },
    })
  })

  it('parses explicit stream state_type', () => {
    const result = StatePayload.parse({
      state_type: 'stream',
      stream: 'orders',
      data: {},
    })
    expect(result.state_type).toBe('stream')
  })

  it('parses global state_type', () => {
    const result = StatePayload.parse({
      state_type: 'global',
      data: { events_cursor: 'evt_1' },
    })
    expect(result.state_type).toBe('global')
  })
})

describe('stateData helper', () => {
  it('returns data for stream state', () => {
    const msg: SourceStateMessage = {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'orders', data: { cursor: 5 } },
    }
    expect(stateData(msg)).toEqual({ cursor: 5 })
  })

  it('returns data for global state', () => {
    const msg: SourceStateMessage = {
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
    }
    expect(stateData(msg)).toEqual({ events_cursor: 'evt_1' })
  })
})
