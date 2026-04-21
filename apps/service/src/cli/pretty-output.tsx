import React from 'react'
import { Box, Text, renderToString as inkRenderToString } from 'ink'
import { formatProgress } from '@stripe/sync-logger/progress'
import type { ProgressPayload } from '@stripe/sync-protocol'
import type { Pipeline } from '../lib/createSchemas.js'

function render(node: React.ReactNode): string {
  return inkRenderToString(node, { columns: process.stdout.columns || 200 })
}
import { handleResponse } from '@stripe/sync-ts-cli/openapi'
import type { ParsedOperation } from '@stripe/sync-ts-cli/openapi'

// MARK: - Helpers

function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// MARK: - Pipeline List View

import type { PipelineStatus } from '../lib/createSchemas.js'

const STATUS_COLORS: Record<PipelineStatus, string> = {
  ready: 'green',
  backfill: 'yellow',
  setup: 'cyan',
  paused: 'gray',
  error: 'red',
  teardown: 'magenta',
}

function ProgressHeaderLine({ progress }: { progress: ProgressPayload }) {
  const streamEntries = Object.entries(progress.streams)
  const total = streamEntries.length
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const totalRecords = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)

  const counts: Record<string, number> = {}
  for (const [, s] of streamEntries) {
    counts[s.status] = (counts[s.status] ?? 0) + 1
  }
  const parts: string[] = []
  if (counts.completed) parts.push(`${counts.completed} completed`)
  if (counts.started) parts.push(`${counts.started} started`)
  if (counts.errored) parts.push(`${counts.errored} errored`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  if (counts.not_started) parts.push(`${counts.not_started} not_started`)

  const statusLabel =
    progress.derived.status === 'failed'
      ? 'Sync failed'
      : progress.derived.status === 'succeeded'
        ? 'Sync complete'
        : 'Syncing'

  const statusColor =
    progress.derived.status === 'failed'
      ? 'red'
      : progress.derived.status === 'succeeded'
        ? 'green'
        : 'yellow'

  const startedAt = relativeTime(new Date(progress.started_at))

  return (
    <Text>
      <Text color={statusColor} bold>
        {statusLabel}
      </Text>
      <Text dimColor>
        {' '}
        {total} streams ({parts.join(', ')}) — {totalRecords.toLocaleString()} records,{' '}
        {progress.derived.records_per_second.toFixed(1)}/s — {elapsed}s — started {startedAt}
      </Text>
    </Text>
  )
}

function PipelineRow({ pipeline }: { pipeline: Pipeline }) {
  const color = STATUS_COLORS[pipeline.status] ?? 'white'
  const src = pipeline.source.type
  const dst = pipeline.destination.type
  const progress = pipeline.sync_state?.sync_run?.progress

  return (
    <Box flexDirection="column">
      <Box>
        <Box minWidth={36}>
          <Text bold>{pipeline.id}</Text>
        </Box>
        <Box minWidth={12}>
          <Text color={color}>{pipeline.status}</Text>
        </Box>
        <Text dimColor>
          {src} → {dst}
        </Text>
      </Box>
      <Box marginLeft={2}>
        {progress ? (
          <ProgressHeaderLine progress={progress} />
        ) : (
          <Text dimColor>No sync data yet</Text>
        )}
      </Box>
    </Box>
  )
}

function PipelineListView({ pipelines }: { pipelines: Pipeline[] }) {
  if (pipelines.length === 0) {
    return <Text dimColor>No pipelines found.</Text>
  }
  return (
    <Box flexDirection="column" gap={1}>
      {pipelines.map((p) => (
        <PipelineRow key={p.id} pipeline={p} />
      ))}
    </Box>
  )
}

// MARK: - Pipeline Detail View

function PipelineDetailView({ pipeline }: { pipeline: Pipeline }) {
  const color = STATUS_COLORS[pipeline.status] ?? 'white'

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text bold>{pipeline.id}</Text>
          <Text> </Text>
          <Text color={color}>{pipeline.status}</Text>
          {pipeline.desired_status !== 'active' && (
            <Text dimColor> (desired: {pipeline.desired_status})</Text>
          )}
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>
            {pipeline.source.type} → {pipeline.destination.type}
          </Text>
        </Box>
      </Box>

      {pipeline.streams && pipeline.streams.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Streams ({pipeline.streams.length}):</Text>
          <Box marginLeft={2} flexDirection="column">
            {pipeline.streams.slice(0, 20).map((s) => (
              <Text key={s.name} dimColor>
                {s.name}
                {s.sync_mode ? ` (${s.sync_mode})` : ''}
              </Text>
            ))}
            {pipeline.streams.length > 20 && (
              <Text dimColor>... and {pipeline.streams.length - 20} more</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}

function renderPipelineDetail(pipeline: Pipeline): string {
  const base = render(<PipelineDetailView pipeline={pipeline} />)
  const progress = pipeline.sync_state?.sync_run?.progress
  if (!progress) return base
  return `${base}\nProgress:\n${formatProgress(progress)}`
}

// MARK: - Response Formatter

export function createPrettyFormatter(): (
  response: Response,
  operation: ParsedOperation
) => Promise<void> {
  return async (response, operation) => {
    // Errors and non-JSON still use default handling
    if (!response.ok) {
      return handleResponse(response, operation)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      return handleResponse(response, operation)
    }

    const data = await response.json()
    const opId = operation.operationId ?? ''

    if (opId === 'pipelines.create') {
      const pipeline = data as Pipeline
      const header = render(
        <Text>
          <Text color="green">Created</Text> <Text bold>{pipeline.id}</Text>
        </Text>
      )
      const output = `${header}\n${renderPipelineDetail(pipeline)}`
      process.stdout.write(output + '\n')
      return
    }

    if (opId === 'pipelines.list') {
      const list = data as { data: Pipeline[]; has_more: boolean }
      const output = render(<PipelineListView pipelines={list.data} />)
      process.stdout.write(output + '\n')
      return
    }

    if (opId === 'pipelines.get') {
      const pipeline = data as Pipeline
      const output = renderPipelineDetail(pipeline)
      process.stdout.write(output + '\n')
      return
    }

    if (opId === 'pipelines.delete') {
      const result = data as { id: string; deleted: boolean }
      const output = render(
        <Text>
          <Text color="green">Deleted</Text> {result.id}
        </Text>
      )
      process.stdout.write(output + '\n')
      return
    }

    // Fallback: pretty JSON
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}
