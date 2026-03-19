'use client'

import { useEffect, useState } from 'react'

interface SyncStatusProps {
  sessionId: string
}

interface SyncRun {
  account_id: string
  started_at: string
  closed_at: string | null
  status: 'running' | 'complete' | 'error'
  error_message: string | null
  total_processed: number
}

function relativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  return `${diffDay}d ago`
}

function formatDuration(startDate: Date, endDate: Date): string {
  const diffMs = endDate.getTime() - startDate.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)

  if (diffSec < 60) return `${diffSec}s`
  if (diffMin < 60) return `${diffMin}m ${diffSec % 60}s`
  return `${diffHour}h ${diffMin % 60}m`
}

export function SyncStatus({ sessionId }: SyncStatusProps) {
  const [syncRun, setSyncRun] = useState<SyncRun | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch(`/api/status?sessionId=${sessionId}`)
        const data = await response.json()

        if (!response.ok) {
          setError(data.error)
          return
        }

        setSyncRun(data.syncRun)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      }
    }

    fetchStatus()

    // Poll every 5 seconds
    const interval = setInterval(() => {
      fetchStatus()
      setTick((t) => t + 1)
    }, 5000)

    return () => clearInterval(interval)
  }, [sessionId])

  // Error state
  if (error) {
    return (
      <div style={{ ...containerStyle, background: '#fff3cd', color: '#856404' }}>
        <span style={{ fontSize: 20 }}>⚠️</span>
        <span>Cannot read sync status: {error}</span>
      </div>
    )
  }

  // Loading state
  if (syncRun === undefined) {
    return (
      <div style={containerStyle}>
        <span style={{ color: '#888' }}>Loading...</span>
      </div>
    )
  }

  // No runs exist
  if (syncRun === null) {
    return (
      <div style={containerStyle}>
        <span style={{ fontSize: 20 }}>⚪</span>
        <span>Not Started</span>
      </div>
    )
  }

  // Active sync (status = 'running')
  if (syncRun.status === 'running') {
    const startedAt = new Date(syncRun.started_at).toLocaleTimeString()
    return (
      <div style={containerStyle}>
        <span style={{ fontSize: 20 }}>🔄</span>
        <span>
          Syncing since {startedAt} ({syncRun.total_processed.toLocaleString()} items)
        </span>
      </div>
    )
  }

  // Completed sync
  if (syncRun.status === 'complete' && syncRun.closed_at) {
    const duration = formatDuration(new Date(syncRun.started_at), new Date(syncRun.closed_at))
    return (
      <div style={containerStyle}>
        <span style={{ fontSize: 20 }}>✅</span>
        <span>
          Completed {relativeTime(new Date(syncRun.closed_at))} (
          {syncRun.total_processed.toLocaleString()} items, took {duration})
        </span>
      </div>
    )
  }

  // Error state
  return (
    <div style={{ ...containerStyle, background: '#f8d7da' }}>
      <span style={{ fontSize: 20 }}>❌</span>
      <span>Sync error{syncRun.error_message ? `: ${syncRun.error_message}` : ''}</span>
    </div>
  )
}

const containerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '16px 20px',
  background: '#f9f9f9',
  borderRadius: 8,
  fontSize: 16,
}
