import createClient from 'openapi-fetch'
import type { paths as EnginePaths } from '@stripe/sync-engine/openapi'
import type { paths as ServicePaths } from '@stripe/sync-service/openapi'
import type { CatalogStream } from './stream-groups'

const engine = createClient<EnginePaths>({ baseUrl: '/api/engine' })
const service = createClient<ServicePaths>({ baseUrl: '/api/service' })

// ── Engine API ────────────────────────────────────────────────

export interface ConnectorInfo {
  type: string
  config_schema: Record<string, unknown>
}

export async function getSources(): Promise<{ data: ConnectorInfo[] }> {
  const { data, error, response } = await engine.GET('/meta/sources')
  if (error) throw new Error(`GET /meta/sources: ${(response as Response).status}`)
  return data as { data: ConnectorInfo[] }
}

export async function getDestinations(): Promise<{ data: ConnectorInfo[] }> {
  const { data, error, response } = await engine.GET('/meta/destinations')
  if (error) throw new Error(`GET /meta/destinations: ${(response as Response).status}`)
  return data as { data: ConnectorInfo[] }
}

export interface CatalogResponse {
  type: 'catalog'
  streams: CatalogStream[]
}

export async function discover(source: Record<string, unknown>): Promise<CatalogResponse> {
  const { data, error, response } = await engine.POST('/discover', {
    headers: { 'x-pipeline': JSON.stringify({ source, destination: { type: '_' } }) },
  })
  if (error) {
    const msg = (error as { error?: string }).error ?? `Discover failed: ${response.status}`
    throw new Error(msg)
  }
  return data as CatalogResponse
}

// ── Service API ───────────────────────────────────────────────

export interface CreatePipelineParams {
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams: Array<{ name: string }>
}

export interface PipelineStatus {
  phase: string
  paused: boolean
  iteration: number
}

export interface Pipeline {
  id: string
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams?: Array<{ name: string }>
  status?: PipelineStatus
}

export async function listPipelines(): Promise<{ data: Pipeline[]; has_more: boolean }> {
  const { data, error, response } = await service.GET('/pipelines')
  if (error) throw new Error(`GET /pipelines: ${(response as Response).status}`)
  return data as { data: Pipeline[]; has_more: boolean }
}

export async function getPipeline(id: string): Promise<Pipeline> {
  const { data, error, response } = await service.GET('/pipelines/{id}', {
    params: { path: { id } },
  })
  if (error) throw new Error(`GET /pipelines/${id}: ${response.status}`)
  return data as Pipeline
}

export async function pausePipeline(id: string): Promise<Pipeline> {
  const { data, error, response } = await service.POST('/pipelines/{id}/pause', {
    params: { path: { id } },
  })
  if (error) throw new Error(`POST /pipelines/${id}/pause: ${response.status}`)
  return data as Pipeline
}

export async function resumePipeline(id: string): Promise<Pipeline> {
  const { data, error, response } = await service.POST('/pipelines/{id}/resume', {
    params: { path: { id } },
  })
  if (error) throw new Error(`POST /pipelines/${id}/resume: ${response.status}`)
  return data as Pipeline
}

export async function deletePipeline(id: string): Promise<void> {
  const { error, response } = await service.DELETE('/pipelines/{id}', {
    params: { path: { id } },
  })
  if (error) throw new Error(`DELETE /pipelines/${id}: ${response.status}`)
}

export async function createPipeline(params: CreatePipelineParams): Promise<Pipeline> {
  const { data, error, response } = await service.POST('/pipelines', { body: params as never })
  if (error) {
    const msg = (error as { error?: string }).error ?? `Create failed: ${response.status}`
    throw new Error(msg)
  }
  return data as Pipeline
}
