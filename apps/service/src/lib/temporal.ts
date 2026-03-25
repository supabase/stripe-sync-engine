import type { ConfigStore } from './stores.js'
import type { SyncConfig } from './schemas.js'

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
    private configs: ConfigStore
  ) {}

  /** Deterministic workflow ID for a given sync. */
  private workflowId(syncId: string): string {
    return `sync_${syncId}`
  }

  /**
   * Start a `syncWorkflow` for the given sync config.
   * Uses deterministic workflow ID so one workflow per sync.
   */
  async start(syncId: string, config: SyncConfig): Promise<void> {
    await this.client.start('syncWorkflow', {
      workflowId: this.workflowId(syncId),
      taskQueue: this.taskQueue,
      args: [
        {
          source_name: config.source.type,
          destination_name: config.destination.type,
          source_config: config.source,
          destination_config: config.destination,
          streams: config.streams,
        },
      ],
    })
  }

  /** Signal the workflow to delete (triggers teardown + exit). */
  async stop(syncId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(syncId))
    try {
      await handle.signal('delete')
    } catch {
      // Workflow may already be completed — ignore signal failures
    }
  }

  /** Signal the workflow to pause. */
  async pause(syncId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(syncId))
    await handle.signal('pause')
  }

  /** Signal the workflow to resume. */
  async resume(syncId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(syncId))
    await handle.signal('resume')
  }

  /** Signal the workflow to update its config (e.g. after PATCH /syncs/{id}). */
  async updateConfig(syncId: string, config: Partial<SyncConfig>): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(syncId))
    await handle.signal('update_config', {
      source_name: config.source?.type,
      destination_name: config.destination?.type,
      source_config: config.source,
      destination_config: config.destination,
      streams: config.streams,
    })
  }

  /** Fan out a webhook event to all workflow syncs sharing the credential. */
  pushEvent(credentialId: string, event: unknown): void {
    this.configs.list().then((syncs) => {
      for (const sync of syncs) {
        if (sync.source.credential_id === credentialId) {
          const handle = this.client.getHandle(this.workflowId(sync.id))
          handle.signal('stripe_event', event).catch(() => {
            // Workflow may not be running — ignore signal failures
          })
        }
      }
    })
  }
}
