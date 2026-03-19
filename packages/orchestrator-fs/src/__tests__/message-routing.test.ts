import { describe, it, expect, vi } from 'vitest'
import type {
  DestinationOutput,
  ErrorMessage,
  LogMessage,
  Message,
  RecordMessage,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { FsOrchestrator, type FsSyncConfig } from '../index'

async function* toAsync<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item
}

async function drain<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

const record1: RecordMessage = {
  type: 'record',
  stream: 'customers',
  data: { id: 'cus_1' },
  emitted_at: 1000,
}

const state1: StateMessage = {
  type: 'state',
  stream: 'customers',
  data: { cursor: 'abc' },
}

const logMsg: LogMessage = { type: 'log', level: 'info', message: 'hello' }
const errorMsg: ErrorMessage = {
  type: 'error',
  failure_type: 'transient_error',
  message: 'oops',
}
const statusMsg: StreamStatusMessage = {
  type: 'stream_status',
  stream: 'customers',
  status: 'running',
}

const stubSync: FsSyncConfig = {
  id: 'test-sync',
  source: {},
  destination: {},
}

describe('FsOrchestrator', () => {
  describe('forward()', () => {
    it('passes RecordMessage and StateMessage, drops others', async () => {
      const orch = new FsOrchestrator(stubSync, '/tmp/unused')
      const messages: Message[] = [record1, logMsg, state1, errorMsg, statusMsg]
      const result = await drain(orch.forward(toAsync(messages)))
      expect(result).toHaveLength(2)
      expect(result[0]).toBe(record1)
      expect(result[1]).toBe(state1)
    })

    it('routes log messages to onLog callback', async () => {
      const onLog = vi.fn()
      const orch = new FsOrchestrator(stubSync, '/tmp/unused', { onLog })
      await drain(orch.forward(toAsync([logMsg])))
      expect(onLog).toHaveBeenCalledOnce()
      expect(onLog).toHaveBeenCalledWith('hello', 'info')
    })

    it('routes error messages to onError callback', async () => {
      const onError = vi.fn()
      const orch = new FsOrchestrator(stubSync, '/tmp/unused', { onError })
      await drain(orch.forward(toAsync([errorMsg])))
      expect(onError).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith('oops', 'transient_error')
    })
  })

  describe('collect()', () => {
    it('yields StateMessage', async () => {
      const orch = new FsOrchestrator(stubSync, '/tmp/unused')
      const output: DestinationOutput[] = [state1]
      const result = await drain(orch.collect(toAsync(output)))
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(state1)
    })

    it('routes log and error messages to callbacks', async () => {
      const onLog = vi.fn()
      const onError = vi.fn()
      const orch = new FsOrchestrator(stubSync, '/tmp/unused', { onLog, onError })
      const output: DestinationOutput[] = [logMsg, errorMsg, state1]
      const result = await drain(orch.collect(toAsync(output)))
      expect(result).toHaveLength(1)
      expect(onLog).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledOnce()
    })
  })
})
