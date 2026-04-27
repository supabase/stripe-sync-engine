import createClient from 'openapi-fetch'
import type { paths as EnginePaths } from '@stripe/sync-engine/openapi'
import type { paths as ServicePaths } from '@stripe/sync-service/openapi'
import type { CatalogStream } from './stream-groups'

const engine = createClient<EnginePaths>({ baseUrl: '/api/engine' })
const service = createClient<ServicePaths>({ baseUrl: '/api/service' })

// Derive Pipeline type from the generated OpenAPI spec
type PipelinesGetResponse =
  ServicePaths['/pipelines/{id}']['get']['responses']['200']['content']['application/json']
export type Pipeline = PipelinesGetResponse
export type DesiredStatus = Pipeline['desired_status']
export type PipelineStatus = Pipeline['status']

// ── Engine API ────────────────────────────────────────────────

export interface ConnectorInfo {
  type: string
  config_schema: Record<string, unknown>
}

export async function getSources(): Promise<{ items: ConnectorInfo[] }> {
  const { data, error, response } = await engine.GET('/meta/sources')
  if (error) throw new Error(`GET /meta/sources: ${(response as Response).status}`)
  return data as { items: ConnectorInfo[] }
}

export async function getDestinations(): Promise<{ items: ConnectorInfo[] }> {
  const { data, error, response } = await engine.GET('/meta/destinations')
  if (error) throw new Error(`GET /meta/destinations: ${(response as Response).status}`)
  return data as { items: ConnectorInfo[] }
}

export interface CatalogResponse {
  streams: CatalogStream[]
}

export async function discover(source: Record<string, unknown>): Promise<CatalogResponse> {
  const response = await fetch('/api/engine/source_discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Discover failed (${response.status}): ${text}`)
  }
  const text = await response.text()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const msg = JSON.parse(line) as { type: string; catalog?: { streams: CatalogStream[] } }
    if (msg.type === 'catalog' && msg.catalog) return { streams: msg.catalog.streams }
  }
  throw new Error('Discover stream ended without a catalog message')
}

// ── Service API ───────────────────────────────────────────────

export interface CreatePipelineParams {
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams: Array<{ name: string }>
}

export async function listPipelines() {
  const { data, error, response } = await service.GET('/pipelines')
  if (error) throw new Error(`GET /pipelines: ${(response as Response).status}`)
  return data!
}

export async function getPipeline(id: string) {
  const { data, error, response } = await service.GET('/pipelines/{id}', {
    params: { path: { id } },
  })
  if (error) throw new Error(`GET /pipelines/${id}: ${response.status}`)
  return data!
}

export async function updatePipeline(
  id: string,
  patch: { desired_status?: DesiredStatus; [key: string]: unknown }
) {
  const { data, error, response } = await service.PATCH('/pipelines/{id}', {
    params: { path: { id } },
    body: patch as never,
  })
  if (error) throw new Error(`PATCH /pipelines/${id}: ${response.status}`)
  return data!
}

export async function pausePipeline(id: string) {
  return updatePipeline(id, { desired_status: 'paused' })
}

export async function resumePipeline(id: string) {
  return updatePipeline(id, { desired_status: 'active' })
}

export async function deletePipeline(id: string) {
  await updatePipeline(id, { desired_status: 'deleted' })
}

export async function createPipeline(params: CreatePipelineParams) {
  const { data, error, response } = await service.POST('/pipelines', { body: params as never })
  if (error) {
    const msg = (error as { error?: string }).error ?? `Create failed: ${response.status}`
    throw new Error(msg)
  }
  return data!
}
