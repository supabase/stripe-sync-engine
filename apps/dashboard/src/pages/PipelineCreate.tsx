import { useState, useEffect } from 'react'
import {
  getSources,
  getDestinations,
  discover,
  createPipeline,
  type ConnectorInfo,
} from '@/lib/api'
import { JsonSchemaForm } from '@/components/JsonSchemaForm'
import { StreamSelector } from '@/components/StreamSelector'
import type { CatalogStream } from '@/lib/stream-groups'

type Step = 'source' | 'streams' | 'destination' | 'review'

export function PipelineCreate({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useState<Step>('source')

  // Connector metadata
  const [sources, setSources] = useState<Record<string, ConnectorInfo>>({})
  const [destinations, setDestinations] = useState<Record<string, ConnectorInfo>>({})

  // Form state
  const [sourceType, setSourceType] = useState('')
  const [sourceConfig, setSourceConfig] = useState<Record<string, unknown>>({})
  const [destType, setDestType] = useState('')
  const [destConfig, setDestConfig] = useState<Record<string, unknown>>({})

  // Catalog / stream selection
  const [catalog, setCatalog] = useState<CatalogStream[]>([])
  const [selectedStreams, setSelectedStreams] = useState<Set<string>>(new Set())
  const [discovering, setDiscovering] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load available connectors on mount
  useEffect(() => {
    Promise.all([getSources(), getDestinations()]).then(([srcs, dests]) => {
      const srcMap = Object.fromEntries(srcs.data.map((c) => [c.type, c]))
      const destMap = Object.fromEntries(dests.data.map((c) => [c.type, c]))
      setSources(srcMap)
      setDestinations(destMap)
      if (srcs.data.length === 1) setSourceType(srcs.data[0].type)
      if (dests.data.length === 1) setDestType(dests.data[0].type)
    })
  }, [])

  // Discover streams when moving to stream selection
  async function discoverStreams() {
    setDiscovering(true)
    setError(null)
    try {
      const catalog = await discover({ type: sourceType, ...sourceConfig })
      setCatalog(catalog.streams)
      setStep('streams')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discover failed')
    } finally {
      setDiscovering(false)
    }
  }

  function toggleStream(name: string) {
    setSelectedStreams((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleAll(names: string[], checked: boolean) {
    setSelectedStreams((prev) => {
      const next = new Set(prev)
      for (const n of names) {
        if (checked) next.add(n)
        else next.delete(n)
      }
      return next
    })
  }

  async function handleCreate() {
    setCreating(true)
    setError(null)
    try {
      await createPipeline({
        source: { type: sourceType, ...sourceConfig },
        destination: { type: destType, ...destConfig },
        streams: [...selectedStreams].map((name) => ({ name })),
      })
      // Success — navigate back to list
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pipeline')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-8 text-2xl font-bold">Create Pipeline</h1>

      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Step indicator */}
      <div className="mb-8 flex gap-2">
        {(['source', 'streams', 'destination', 'review'] as const).map((s, i) => (
          <div
            key={s}
            className={`flex-1 rounded-full py-1 text-center text-xs font-medium ${
              s === step
                ? 'bg-indigo-100 text-indigo-700'
                : i < ['source', 'streams', 'destination', 'review'].indexOf(step)
                  ? 'bg-indigo-500 text-white'
                  : 'bg-gray-100 text-gray-400'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </div>
        ))}
      </div>

      {/* Step: Source config */}
      {step === 'source' && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Source</label>
            <select
              value={sourceType}
              onChange={(e) => {
                setSourceType(e.target.value)
                setSourceConfig({})
              }}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="">— select source —</option>
              {Object.keys(sources).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {sourceType && sources[sourceType] && (
            <JsonSchemaForm
              schema={sources[sourceType].config_schema}
              values={sourceConfig}
              onChange={setSourceConfig}
            />
          )}

          <button
            disabled={!sourceType || discovering}
            onClick={discoverStreams}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {discovering ? 'Discovering streams...' : 'Next: Select streams'}
          </button>
        </div>
      )}

      {/* Step: Stream selection */}
      {step === 'streams' && (
        <div className="flex flex-col gap-6">
          <StreamSelector
            streams={catalog}
            selected={selectedStreams}
            onToggle={toggleStream}
            onToggleAll={toggleAll}
          />
          <div className="flex gap-3">
            <button
              onClick={() => setStep('source')}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm"
            >
              Back
            </button>
            <button
              disabled={selectedStreams.size === 0}
              onClick={() => setStep('destination')}
              className="flex-1 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              Next: Configure destination ({selectedStreams.size} tables selected)
            </button>
          </div>
        </div>
      )}

      {/* Step: Destination config */}
      {step === 'destination' && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Destination</label>
            <select
              value={destType}
              onChange={(e) => {
                setDestType(e.target.value)
                setDestConfig({})
              }}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="">— select destination —</option>
              {Object.keys(destinations).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {destType && destinations[destType] && (
            <JsonSchemaForm
              schema={destinations[destType].config_schema}
              values={destConfig}
              onChange={setDestConfig}
            />
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('streams')}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm"
            >
              Back
            </button>
            <button
              disabled={!destType}
              onClick={() => setStep('review')}
              className="flex-1 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              Next: Review
            </button>
          </div>
        </div>
      )}

      {/* Step: Review & create */}
      {step === 'review' && (
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="mb-2 font-semibold">Source</h3>
            <p className="text-sm text-gray-600">
              <span className="font-mono font-medium">{sourceType}</span>
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="mb-2 font-semibold">Streams</h3>
            <p className="text-sm text-gray-600">{selectedStreams.size} tables selected</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {[...selectedStreams].sort().map((name) => (
                <span
                  key={name}
                  className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="mb-2 font-semibold">Destination</h3>
            <p className="text-sm text-gray-600">
              <span className="font-mono font-medium">{destType}</span>
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep('destination')}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm"
            >
              Back
            </button>
            <button
              disabled={creating}
              onClick={handleCreate}
              className="flex-1 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Start sync'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
