import { describe, expect, it, vi } from 'vitest'

const runMock = vi.fn(async () => {})
const createWorkerMock = vi.fn(async () => ({ run: runMock }))

vi.mock('./temporal/worker.js', () => ({
  createWorker: createWorkerMock,
}))

describe('worker CLI', () => {
  it('threads worker args through to createWorker', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const program = (await createProgram()) as {
      subCommands: Record<
        string,
        {
          args: Record<string, unknown>
          run: (input: { args: Record<string, string> }) => Promise<void>
        }
      >
    }

    await program.subCommands['worker']!.run({
      args: {
        'temporal-address': 'localhost:7233',
        'temporal-namespace': 'default',
        'temporal-task-queue': 'sync-engine',
        'engine-url': 'http://localhost:4010',
        'data-dir': '/tmp/test-pipelines',
      },
    })

    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineUrl: 'http://localhost:4010',
        taskQueue: 'sync-engine',
      })
    )
    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        kafkaBroker: expect.anything(),
      })
    )
    expect(runMock).toHaveBeenCalledOnce()
  })
})
