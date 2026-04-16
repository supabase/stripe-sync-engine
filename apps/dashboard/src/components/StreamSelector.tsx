import { useState, useMemo } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  groupStreams,
  filterStreams,
  type CatalogStream,
  type StreamGroup,
} from '@/lib/stream-groups'

interface StreamSelectorProps {
  streams: CatalogStream[]
  selected: Set<string>
  onToggle: (name: string) => void
  onToggleAll: (names: string[], checked: boolean) => void
}

export function StreamSelector({ streams, selected, onToggle, onToggleAll }: StreamSelectorProps) {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'all' | 'selected'>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => filterStreams(streams, search), [streams, search])
  const visible = useMemo(
    () => (tab === 'selected' ? filtered.filter((s) => selected.has(s.name)) : filtered),
    [filtered, tab, selected]
  )
  const groups = useMemo(() => groupStreams(visible), [visible])

  const allNames = streams.map((s) => s.name)
  const allSelected = allNames.length > 0 && allNames.every((n) => selected.has(n))
  const someSelected = allNames.some((n) => selected.has(n))

  function toggleGroup(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Select tables to sync</h2>

      {/* Tabs */}
      <div className="flex gap-4 border-b">
        <button
          className={cn(
            'pb-2 text-sm font-medium',
            tab === 'all' ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-gray-500'
          )}
          onClick={() => setTab('all')}
        >
          All tables
        </button>
        <button
          className={cn(
            'pb-2 text-sm font-medium',
            tab === 'selected' ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-gray-500'
          )}
          onClick={() => setTab('selected')}
        >
          Selected tables ({selected.size})
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Find table"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-200 py-2 pl-10 pr-4 text-sm focus:border-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
        />
      </div>

      {/* Select all */}
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected
          }}
          onChange={() => onToggleAll(allNames, !allSelected)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600"
        />
        <span className="font-medium">Select all tables</span>
      </label>

      {/* Groups */}
      <div className="flex flex-col divide-y">
        {groups.map((group) => (
          <GroupRow
            key={group.name}
            group={group}
            selected={selected}
            expanded={expanded.has(group.name)}
            onToggleExpand={() => toggleGroup(group.name)}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
          />
        ))}
      </div>
    </div>
  )
}

function GroupRow({
  group,
  selected,
  expanded,
  onToggleExpand,
  onToggle,
  onToggleAll,
}: {
  group: StreamGroup
  selected: Set<string>
  expanded: boolean
  onToggleExpand: () => void
  onToggle: (name: string) => void
  onToggleAll: (names: string[], checked: boolean) => void
}) {
  const names = group.streams.map((s) => s.name)
  const allChecked = names.every((n) => selected.has(n))
  const someChecked = names.some((n) => selected.has(n))

  return (
    <div>
      <div className="flex items-center gap-3 py-3">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = someChecked && !allChecked
          }}
          onChange={() => onToggleAll(names, !allChecked)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600"
        />
        <button onClick={onToggleExpand} className="flex flex-1 items-center gap-2 text-left">
          <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
          <span className="font-semibold">{group.name}</span>
        </button>
        <span className="text-sm text-gray-400">
          {group.streams.length} {group.streams.length === 1 ? 'table' : 'tables'}
        </span>
      </div>

      {expanded && (
        <div className="ml-10 flex flex-col gap-2 pb-3">
          {group.streams.map((stream) => (
            <label key={stream.name} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={selected.has(stream.name)}
                onChange={() => onToggle(stream.name)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              <span className="font-mono text-gray-700">{stream.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
