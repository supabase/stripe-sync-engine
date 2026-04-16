import type { ConfiguredCatalog } from '@stripe/sync-engine'
import { applySelection, buildCatalog } from '@stripe/sync-engine'
import { collectFirst } from '@stripe/sync-protocol'
import type { ActivitiesContext } from './_shared.js'

export function createDiscoverCatalogActivity(context: ActivitiesContext) {
  return async function discoverCatalog(pipelineId: string): Promise<ConfiguredCatalog> {
    const { source, streams } = await context.pipelineStore.get(pipelineId)
    const catalogMsg = await collectFirst(context.engine.source_discover(source), 'catalog')
    return applySelection(buildCatalog(catalogMsg.catalog.streams, streams))
  }
}
