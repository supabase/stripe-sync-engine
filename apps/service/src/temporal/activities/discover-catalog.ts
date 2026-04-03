import { applySelection, buildCatalog } from '@stripe/sync-engine'
import type { ConfiguredCatalog, PipelineConfig, Stream } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { pipelineHeader } from './_shared.js'

export function createDiscoverCatalogActivity(context: ActivitiesContext) {
  return async function discoverCatalog(config: PipelineConfig): Promise<ConfiguredCatalog> {
    const response = await fetch(`${context.engineUrl}/discover`, {
      method: 'POST',
      headers: { 'x-pipeline': pipelineHeader(config) },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Engine /discover failed (${response.status}): ${text}`)
    }
    const payload = (await response.json()) as { streams: Stream[] }
    return applySelection(buildCatalog(payload.streams, config.streams))
  }
}
