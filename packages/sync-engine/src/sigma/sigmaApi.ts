import Papa from 'papaparse'
import Stripe from 'stripe'
import pkg from '../../package.json' with { type: 'json' }
import type { Logger } from '../types'

type SigmaQueryRunStatus = 'running' | 'succeeded' | 'failed'

type SigmaQueryRun = {
  id: string
  status: SigmaQueryRunStatus
  error: unknown | null
  result?: {
    file?: string | null
  }
}

const STRIPE_FILES_BASE = 'https://files.stripe.com/v1'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseCsvObjects(csv: string): Array<Record<string, string | null>> {
  const input = csv.replace(/^\uFEFF/, '')

  const parsed = Papa.parse<Record<string, string>>(input, {
    header: true,
    skipEmptyLines: 'greedy',
  })

  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse Sigma CSV: ${parsed.errors[0]?.message ?? 'unknown error'}`)
  }

  return parsed.data
    .filter((row) => row && Object.keys(row).length > 0)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v == null || v === '' ? null : String(v)])
      )
    )
}

export function normalizeSigmaTimestampToIso(value: string): string | null {
  const v = value.trim()
  if (!v) return null

  const hasExplicitTz = /z$|[+-]\d{2}:?\d{2}$/i.test(v)
  const isoish = v.includes('T') ? v : v.replace(' ', 'T')
  const candidate = hasExplicitTz ? isoish : `${isoish}Z`

  const d = new Date(candidate)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function fetchStripeText(url: string, apiKey: string, options: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Sigma file download error (${res.status}) for ${url}: ${text}`)
  }
  return text
}

export async function runSigmaQueryAndDownloadCsv(params: {
  apiKey: string
  sql: string
  logger?: Logger
  pollTimeoutMs?: number
  pollIntervalMs?: number
}): Promise<{ queryRunId: string; fileId: string; csv: string }> {
  const pollTimeoutMs = params.pollTimeoutMs ?? 5 * 60 * 1000
  const pollIntervalMs = params.pollIntervalMs ?? 2000

  const stripe = new Stripe(params.apiKey, {
    appInfo: {
      name: 'Stripe Sync Engine',
      version: pkg.version,
      url: pkg.homepage,
    },
  })

  // 1) Create query run
  const created = (await stripe.rawRequest('POST', '/v1/sigma/query_runs', {
    sql: params.sql,
  })) as unknown as SigmaQueryRun

  const queryRunId = created.id

  // 2) Poll until succeeded
  const start = Date.now()
  let current: SigmaQueryRun = created

  while (current.status === 'running') {
    if (Date.now() - start > pollTimeoutMs) {
      throw new Error(`Sigma query run timed out after ${pollTimeoutMs}ms: ${queryRunId}`)
    }
    await sleep(pollIntervalMs)

    current = (await stripe.rawRequest(
      'GET',
      `/v1/sigma/query_runs/${queryRunId}`,
      {}
    )) as unknown as SigmaQueryRun
  }

  if (current.status !== 'succeeded') {
    throw new Error(
      `Sigma query run did not succeed (status=${current.status}) id=${queryRunId} error=${JSON.stringify(
        current.error
      )}`
    )
  }

  const fileId = current.result?.file
  if (!fileId) {
    throw new Error(`Sigma query run succeeded but result.file is missing (id=${queryRunId})`)
  }

  // 3) Download file contents (CSV)
  const csv = await fetchStripeText(
    `${STRIPE_FILES_BASE}/files/${fileId}/contents`,
    params.apiKey,
    { method: 'GET' }
  )

  return { queryRunId, fileId, csv }
}
