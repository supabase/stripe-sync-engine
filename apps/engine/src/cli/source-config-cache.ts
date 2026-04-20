import type { PipelineConfig, ControlPayload } from '@stripe/sync-protocol'

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
