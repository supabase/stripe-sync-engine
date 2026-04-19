import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PipelineConfig, ControlPayload } from '@stripe/sync-protocol'

type PersistedStripeSourceConfig = {
  account_id?: string
  account_created?: number
}

export function readPersistedStripeSourceConfig(
  filePath: string
): PersistedStripeSourceConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PersistedStripeSourceConfig
    if (parsed.account_id || parsed.account_created != null) return parsed
    return undefined
  } catch {
    return undefined
  }
}

export function writePersistedStripeSourceConfig(
  filePath: string,
  sourceConfig: Record<string, unknown>
): void {
  const persisted = {
    account_id: typeof sourceConfig.account_id === 'string' ? sourceConfig.account_id : undefined,
    account_created:
      typeof sourceConfig.account_created === 'number' ? sourceConfig.account_created : undefined,
  } satisfies PersistedStripeSourceConfig

  if (!persisted.account_id && persisted.account_created == null) return

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(persisted, null, 2) + '\n')
}

export function applyControlToPipeline(
  pipeline: PipelineConfig,
  control: ControlPayload
): PipelineConfig {
  if (control.control_type === 'source_config') {
    const type = pipeline.source.type
    return { ...pipeline, source: { type, [type]: control.source_config } }
  }

  const type = pipeline.destination.type
  return { ...pipeline, destination: { type, [type]: control.destination_config } }
}
