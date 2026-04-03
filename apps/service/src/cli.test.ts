import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runMock = vi.fn(async () => {})
const createWorkerMock = vi.fn(async () => ({ run: runMock }))

vi.mock('./temporal/worker.js', () => ({
  createWorker: createWorkerMock,
}))

describe('worker CLI', () => {
  const originalKafkaBroker = process.env['KAFKA_BROKER']

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env['KAFKA_BROKER']
  })

  afterEach(() => {
    if (originalKafkaBroker === undefined) {
      delete process.env['KAFKA_BROKER']
    } else {
      process.env['KAFKA_BROKER'] = originalKafkaBroker
    }
  })

  it('threads --kafka-broker through to createWorker', async () => {
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

    expect(program.subCommands['worker']?.args['kafka-broker']).toBeDefined()

    await program.subCommands['worker']!.run({
      args: {
        'temporal-address': 'localhost:7233',
        'temporal-namespace': 'default',
        'temporal-task-queue': 'sync-engine',
        'engine-url': 'http://localhost:4010',
        'kafka-broker': 'localhost:9092',
      },
    })

    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kafkaBroker: 'localhost:9092',
      })
    )
    expect(runMock).toHaveBeenCalledOnce()
  })

  it('falls back to KAFKA_BROKER when the flag is omitted', async () => {
    process.env['KAFKA_BROKER'] = 'env-broker:9092'
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const program = (await createProgram()) as {
      subCommands: Record<
        string,
        {
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
      },
    })

    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kafkaBroker: 'env-broker:9092',
      })
    )
  })
})
