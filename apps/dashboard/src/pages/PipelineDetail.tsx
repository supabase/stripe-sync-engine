import { useState, useEffect } from 'react'
import {
  getPipeline,
  pausePipeline,
  resumePipeline,
  deletePipeline,
  type Pipeline,
} from '@/lib/api'
import { inferGroupName } from '@/lib/stream-groups'
import { cn } from '@/lib/utils'

interface PipelineDetailProps {
  id: string
  onBack: () => void
}

export function PipelineDetail({ id, onBack }: PipelineDetailProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setPipeline(await getPipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipeline')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [id])

  async function handlePause() {
    setActing(true)
    try {
      setPipeline(await pausePipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pause failed')
    } finally {
      setActing(false)
    }
  }

  async function handleResume() {
    setActing(true)
    try {
      setPipeline(await resumePipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete pipeline ${id}?`)) return
    setActing(true)
    try {
      await deletePipeline(id)
      onBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <button onClick={onBack} className="text-sm text-indigo-600 hover:text-indigo-700">
          Back to pipelines
        </button>
      </div>
    )
  }

  const sourceType = String(pipeline.source?.type ?? 'unknown')
  const destType = String(pipeline.destination?.type ?? 'unknown')
  const phase = pipeline.status?.phase ?? 'unknown'
  const paused = pipeline.status?.paused ?? false
  const iteration = pipeline.status?.iteration ?? 0
  const streams = pipeline.streams ?? []

  return (
    <div className="mx-auto max-w-4xl p-8">
      {/* Breadcrumb */}
      <button onClick={onBack} className="mb-4 text-sm text-indigo-600 hover:text-indigo-700">
        Pipelines &rsaquo;
      </button>

      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100 text-xl">
            {sourceType === 'stripe' ? '💳' : '📦'}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">
                {sourceType} → {destType}
              </h1>
              <StatusBadge phase={phase} paused={paused} />
            </div>
            <p className="text-sm text-gray-500">{pipeline.id}</p>
            {iteration > 0 && <p className="text-xs text-gray-400">Iteration {iteration}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          {paused ? (
            <button
              disabled={acting}
              onClick={handleResume}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Resume
            </button>
          ) : (
            <button
              disabled={acting}
              onClick={handlePause}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Pause
            </button>
          )}
          <button
            disabled={acting}
            onClick={handleDelete}
            className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Tables synced */}
      <h2 className="mb-4 text-xl font-semibold">Tables synced</h2>

      {streams.length === 0 ? (
        <p className="text-sm text-gray-400">No tables configured</p>
      ) : (
        <>
          <p className="mb-4 text-sm text-gray-500">
            Viewing {streams.length} {streams.length === 1 ? 'result' : 'results'}
          </p>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-sm font-medium text-gray-600">
                  <th className="px-4 py-3">Table</th>
                  <th className="px-4 py-3">Category</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {streams
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((stream) => (
                    <tr key={stream.name} className="text-sm hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {formatTableName(stream.name)}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{inferGroupName(stream.name)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function StatusBadge({ phase, paused }: { phase: string; paused: boolean }) {
  if (paused) {
    return (
      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
        Paused
      </span>
    )
  }
  const colors: Record<string, string> = {
    running: 'bg-green-100 text-green-700',
    setup: 'bg-blue-100 text-blue-700',
    complete: 'bg-gray-100 text-gray-700',
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        colors[phase] ?? 'bg-gray-100 text-gray-600'
      )}
    >
      {phase.charAt(0).toUpperCase() + phase.slice(1)}
    </span>
  )
}

function formatTableName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
