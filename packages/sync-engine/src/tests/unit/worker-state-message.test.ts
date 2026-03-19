import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSyncWorker, type WorkerTaskManager, type SyncTask } from '../../stripeSyncWorker'
import type { ResourceConfig } from '../../types'
import type { StateMessage } from '../../protocol/types'

/**
 * Tests for StateMessage emission from StripeSyncWorker.updateTaskProgress().
 *
 * The worker has an optional onStateMessage callback that fires after each
 * updateSyncObject() call in updateTaskProgress(). These tests verify:
 * - Correct StateMessage shape
 * - Status mapping (complete vs pending)
 * - Backward compatibility (no callback = no error)
 * - Cursor data accuracy
 * - No emission on error paths
 */
describe('Worker StateMessage emission', () => {
  let mockListFn: ReturnType<typeof vi.fn>
  let mockUpdateSyncObject: ReturnType<typeof vi.fn>
  let mockTaskManager: WorkerTaskManager
  let resourceRegistry: Record<string, ResourceConfig>

  const task: SyncTask = {
    object: 'customers',
    cursor: '1700000000',
    pageCursor: null,
    created_gte: 0,
    created_lte: 1700000000,
  }

  beforeEach(() => {
    mockListFn = vi.fn()
    mockUpdateSyncObject = vi.fn().mockResolvedValue(1)
    mockTaskManager = {
      claimNextTask: vi.fn().mockResolvedValue(null),
      updateSyncObject: mockUpdateSyncObject,
      releaseObjectSync: vi.fn().mockResolvedValue(undefined),
    }
    resourceRegistry = {
      customer: {
        tableName: 'customers',
        order: 0,
        supportsCreatedFilter: true,
        listFn: mockListFn,
      } as unknown as ResourceConfig,
    }
  })

  function createWorker(onStateMessage?: (msg: StateMessage) => void) {
    return new StripeSyncWorker(
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      mockTaskManager,
      'acct_test',
      resourceRegistry,
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      { accountId: 'acct_test', runStartedAt: new Date() },
      vi.fn().mockResolvedValue([]) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      Infinity,
      50,
      onStateMessage
    )
  }

  it('onStateMessage callback fires after updateTaskProgress with correct StateMessage shape', async () => {
    mockListFn.mockResolvedValue({
      data: [
        { id: 'cus_1', created: 1700000100 },
        { id: 'cus_2', created: 1700000200 },
      ],
      has_more: false,
    })

    const received: StateMessage[] = []
    const worker = createWorker((msg) => received.push(msg))

    await worker.processSingleTask(task)

    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe('state')
    expect(received[0]!.stream).toBe('customers')
    expect(received[0]!.data).toBeDefined()
  })

  it('onStateMessage receives status=complete when task finishes', async () => {
    mockListFn.mockResolvedValue({
      data: [
        { id: 'cus_1', created: 1700000100 },
        { id: 'cus_2', created: 1700000200 },
      ],
      has_more: false,
    })

    const received: StateMessage[] = []
    const worker = createWorker((msg) => received.push(msg))

    await worker.processSingleTask(task)

    expect(received).toHaveLength(1)
    const data = received[0]!.data as Record<string, unknown>
    expect(data.status).toBe('complete')
    expect(data.pageCursor).toBeNull()
  })

  it('onStateMessage receives status=pending when more pages remain', async () => {
    mockListFn.mockResolvedValue({
      data: [
        { id: 'cus_1', created: 1700000100 },
        { id: 'cus_2', created: 1700000200 },
      ],
      has_more: true,
    })

    const received: StateMessage[] = []
    const worker = createWorker((msg) => received.push(msg))

    await worker.processSingleTask(task)

    expect(received).toHaveLength(1)
    const data = received[0]!.data as Record<string, unknown>
    expect(data.status).toBe('pending')
    expect(data.pageCursor).toBe('cus_2')
  })

  it('worker works normally when onStateMessage is not provided', async () => {
    mockListFn.mockResolvedValue({
      data: [
        { id: 'cus_1', created: 1700000100 },
        { id: 'cus_2', created: 1700000200 },
      ],
      has_more: false,
    })

    const worker = createWorker() // no callback

    const result = await worker.processSingleTask(task)

    expect(result.processed).toBe(2)
    expect(result.hasMore).toBe(false)
    expect(mockUpdateSyncObject).toHaveBeenCalledTimes(1)
  })

  it('onStateMessage is NOT called on error paths', async () => {
    // Trigger the empty-page error path: has_more=true with empty data
    mockListFn.mockResolvedValue({
      data: [],
      has_more: true,
    })

    const received: StateMessage[] = []
    const worker = createWorker((msg) => received.push(msg))

    await worker.processSingleTask(task)

    // updateSyncObject is called twice: once for the error, once for updateTaskProgress
    // But onStateMessage should only fire from updateTaskProgress, not the error path
    // The error path calls updateSyncObject directly (not through updateTaskProgress)
    // updateTaskProgress is still called after — but with empty data and has_more=true
    // Since data.length === 0, the StateMessage will still fire from updateTaskProgress
    // with processedCount: 0. The key point is the error-path updateSyncObject
    // (status='error') does NOT trigger onStateMessage.
    expect(received).toHaveLength(1)
    // Verify the StateMessage came from updateTaskProgress, not the error path
    const data = received[0]!.data as Record<string, unknown>
    expect(data.processedCount).toBe(0)
    // The error-path updateSyncObject (with status='error') did NOT emit a StateMessage
    expect(mockUpdateSyncObject).toHaveBeenCalledTimes(2) // error path + updateTaskProgress
  })

  it('StateMessage data contains cursor info matching updateSyncObject args', async () => {
    mockListFn.mockResolvedValue({
      data: [
        { id: 'cus_1', created: 1700000100 },
        { id: 'cus_2', created: 1700000050 },
      ],
      has_more: true,
    })

    const received: StateMessage[] = []
    const worker = createWorker((msg) => received.push(msg))

    await worker.processSingleTask(task)

    // Verify the StateMessage data matches what was passed to updateSyncObject
    const stateData = received[0]!.data as Record<string, unknown>
    const updateCall = mockUpdateSyncObject.mock.calls[0]!
    const updateArgs = updateCall[5] as Record<string, unknown>

    expect(stateData.cursor).toBe(updateArgs.cursor)
    expect(stateData.pageCursor).toBe(updateArgs.pageCursor)
    expect(stateData.status).toBe(updateArgs.status)
    expect(stateData.processedCount).toBe(updateArgs.processedCount)
  })
})
