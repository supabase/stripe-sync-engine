import { applySelection, buildCatalog, parseNdjsonStream } from '@stripe/sync-engine'
import type { ConfiguredCatalog, PipelineConfig } from '@stripe/sync-engine'
import { collectCatalog } from '@stripe/sync-protocol'
import type { DiscoverOutput } from '@stripe/sync-protocol'
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
    const { catalog } = await collectCatalog(parseNdjsonStream<DiscoverOutput>(response.body!))
    return applySelection(buildCatalog(catalog.streams, config.streams))
  }
}
