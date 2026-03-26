import type { PipelineStore } from '../lib/stores.js'

// MARK: - Types

export interface TemporalOptions {
  /** @temporalio/client WorkflowClient instance (or compatible duck-type). */
  client: {
    start(workflow: string, options: any): Promise<any>
    getHandle(workflowId: string): {
      signal(signal: string, ...args: unknown[]): Promise<any>
      terminate(reason?: string): Promise<any>
    }
  }
  taskQueue: string
}

// MARK: - TemporalBridge

/** Thin bridge between the sync service and a Temporal WorkflowClient. */
export class TemporalBridge {
  constructor(
    private client: TemporalOptions['client'],
    private taskQueue: string,
    private pipelines: PipelineStore
  ) {}

  /** Deterministic workflow ID for a given pipeline. */
  private workflowId(pipelineId: string): string {
    return `pipe_${pipelineId}`
  }

  /**
   * Start a `syncWorkflow` for the given pipeline.
   * Uses deterministic workflow ID so one workflow per pipeline.
   * The workflow receives only the pipelineId — it calls the service API
   * which resolves config and state on each activity call.
   */
  async start(pipelineId: string): Promise<void> {
    await this.client.start('syncWorkflow', {
      workflowId: this.workflowId(pipelineId),
      taskQueue: this.taskQueue,
      args: [pipelineId],
    })
  }

  /** Signal the workflow to delete (triggers teardown + exit). */
  async stop(pipelineId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    try {
      await handle.signal('delete')
    } catch {
      // Workflow may already be completed — ignore signal failures
    }
  }

  /** Signal the workflow to pause. */
  async pause(pipelineId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    await handle.signal('pause')
  }

  /** Signal the workflow to resume. */
  async resume(pipelineId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    await handle.signal('resume')
  }

  /** Push a webhook event to the pipeline's Temporal workflow. */
  pushEvent(pipelineId: string, event: unknown): void {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    handle.signal('stripe_event', event).catch(() => {
      // Workflow may not be running — ignore signal failures
    })
  }
}
