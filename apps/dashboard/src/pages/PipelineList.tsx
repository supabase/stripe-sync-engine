import { useState, useEffect } from 'react'
import { listPipelines, deletePipeline, type Pipeline } from '@/lib/api'
import { inferGroupName } from '@/lib/stream-groups'
import { cn } from '@/lib/utils'

interface PipelineListProps {
  onSelect: (id: string) => void
  onCreate: () => void
}

export function PipelineList({ onSelect, onCreate }: PipelineListProps) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await listPipelines()
      setPipelines(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete(id: string) {
    if (!confirm(`Delete pipeline ${id}?`)) return
    try {
      await deletePipeline(id)
      setPipelines((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Pipelines</h1>
        <button
          onClick={onCreate}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600"
        >
          + Add pipeline
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : pipelines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500">No pipelines yet</p>
          <button
            onClick={onCreate}
            className="mt-4 text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            Create your first pipeline
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {pipelines.map((pipeline) => (
            <PipelineCard
              key={pipeline.id}
              pipeline={pipeline}
              onClick={() => onSelect(pipeline.id)}
              onDelete={() => handleDelete(pipeline.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PipelineCard({
  pipeline,
  onClick,
  onDelete,
}: {
  pipeline: Pipeline
  onClick: () => void
  onDelete: () => void
}) {
  const sourceType = String(pipeline.source?.type ?? 'unknown')
  const destType = String(pipeline.destination?.type ?? 'unknown')
  const streams = pipeline.streams ?? []
  const phase = pipeline.status?.phase ?? 'unknown'
  const paused = pipeline.status?.paused

  // Summarize tables: "Payments, Customers, and 8 others"
  const groups = [...new Set(streams.map((s) => inferGroupName(s.name)))]
  const tablesSummary =
    streams.length === 0
      ? 'No tables selected'
      : groups.length <= 2
        ? groups.join(', ')
        : `${groups.slice(0, 2).join(', ')}, and ${groups.length - 2} others`

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-lg border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-lg">
            {sourceType === 'stripe' ? '💳' : '📦'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">
                {sourceType} → {destType}
              </span>
              <StatusBadge phase={phase} paused={paused} />
            </div>
            <p className="text-sm text-gray-500">{pipeline.id}</p>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="text-sm text-gray-400 hover:text-red-500"
        >
          Delete
        </button>
      </div>
      <div className="mt-4 text-sm text-gray-600">
        <span className="font-medium text-gray-700">Tables:</span> {tablesSummary} ({streams.length}
        )
      </div>
    </div>
  )
}

function StatusBadge({ phase, paused }: { phase: string; paused?: boolean }) {
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
