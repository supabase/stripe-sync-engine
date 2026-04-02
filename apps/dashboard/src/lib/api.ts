import type { CatalogStream } from './stream-groups'

const ENGINE_BASE = '/api/engine'
const SERVICE_BASE = '/api/service'

// ── Engine API ────────────────────────────────────────────────

export interface ConnectorInfo {
  config_schema: Record<string, unknown>
}

export interface ConnectorsResponse {
  sources: Record<string, ConnectorInfo>
  destinations: Record<string, ConnectorInfo>
}

export async function getConnectors(): Promise<ConnectorsResponse> {
  const res = await fetch(`${ENGINE_BASE}/connectors`)
  if (!res.ok) throw new Error(`GET /connectors: ${res.status}`)
  return res.json()
}

export interface CatalogResponse {
  type: 'catalog'
  streams: CatalogStream[]
}

export async function discover(source: Record<string, unknown>): Promise<CatalogResponse> {
  const res = await fetch(`${ENGINE_BASE}/discover`, {
    method: 'POST',
    headers: {
      'x-pipeline': JSON.stringify({ source, destination: { type: '_' } }),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Discover failed: ${res.status}`)
  }
  return res.json()
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
  const res = await fetch(`${SERVICE_BASE}/pipelines`)
  if (!res.ok) throw new Error(`GET /pipelines: ${res.status}`)
  return res.json()
}

export async function getPipeline(id: string): Promise<Pipeline> {
  const res = await fetch(`${SERVICE_BASE}/pipelines/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`GET /pipelines/${id}: ${res.status}`)
  return res.json()
}

export async function pausePipeline(id: string): Promise<Pipeline> {
  const res = await fetch(`${SERVICE_BASE}/pipelines/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`POST /pipelines/${id}/pause: ${res.status}`)
  return res.json()
}

export async function resumePipeline(id: string): Promise<Pipeline> {
  const res = await fetch(`${SERVICE_BASE}/pipelines/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`POST /pipelines/${id}/resume: ${res.status}`)
  return res.json()
}

export async function deletePipeline(id: string): Promise<void> {
  const res = await fetch(`${SERVICE_BASE}/pipelines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE /pipelines/${id}: ${res.status}`)
}

export async function createPipeline(params: CreatePipelineParams): Promise<Pipeline> {
  const res = await fetch(`${SERVICE_BASE}/pipelines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Create failed: ${res.status}`)
  }
  return res.json()
}
