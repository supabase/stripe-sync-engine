import { NativeConnection, Worker } from '@temporalio/worker'
import { createActivities } from './activities.js'

export interface WorkerOptions {
  temporalAddress: string
  namespace?: string
  taskQueue: string
  engineUrl: string
  kafkaBroker?: string
  /** Path to compiled workflows.js (Temporal bundles it for V8 sandbox). */
  workflowsPath: string
}

export async function createWorker(opts: WorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: opts.temporalAddress,
  })

  return Worker.create({
    connection,
    namespace: opts.namespace ?? 'default',
    taskQueue: opts.taskQueue,
    workflowsPath: opts.workflowsPath,
    activities: createActivities({
      engineUrl: opts.engineUrl,
      kafkaBroker: opts.kafkaBroker,
    }),
  })
}
