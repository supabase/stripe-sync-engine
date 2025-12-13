'use client'

import { useEffect, useState } from 'react'

interface InstallationStatusProps {
  sessionId: string
  onComplete?: () => void
}

interface InstallationData {
  status: 'not_started' | 'in_progress' | 'completed' | 'error'
  step: string
  comment: string | null
}

export function InstallationStatus({ sessionId, onComplete }: InstallationStatusProps) {
  const [data, setData] = useState<InstallationData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch(`/api/installation-status?sessionId=${sessionId}`)
        const result = await response.json()

        if (!response.ok) {
          setError(result.error)
          return
        }

        setData(result)

        // Stop polling once completed or errored
        if (result.status === 'completed' || result.status === 'error') {
          clearInterval(interval)

          // Call onComplete callback when installation completes successfully
          if (result.status === 'completed' && onComplete) {
            onComplete()
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      }
    }

    fetchStatus()

    // Poll every 2 seconds
    const interval = setInterval(fetchStatus, 2000)

    return () => clearInterval(interval)
  }, [sessionId, onComplete])

  // Error state
  if (error) {
    return (
      <div style={{ ...containerStyle, background: '#fff3cd', color: '#856404' }}>
        <span style={{ fontSize: 20 }}>⚠️</span>
        <span>Cannot read installation status: {error}</span>
      </div>
    )
  }

  // Loading state
  if (!data) {
    return (
      <div style={containerStyle}>
        <span style={{ color: '#888' }}>Loading...</span>
      </div>
    )
  }

  const emoji = {
    not_started: '⚪',
    in_progress: '🔄',
    completed: '✅',
    error: '❌',
  }[data.status]

  // Error state
  if (data.status === 'error') {
    return (
      <div style={{ ...containerStyle, background: '#f8d7da' }}>
        <span style={{ fontSize: 20 }}>{emoji}</span>
        <span>Installation error: {data.step}</span>
      </div>
    )
  }

  // Completed state
  if (data.status === 'completed') {
    return (
      <div style={containerStyle}>
        <span style={{ fontSize: 20 }}>{emoji}</span>
        <span>Installation completed successfully</span>
      </div>
    )
  }

  // In progress or not started
  return (
    <div style={containerStyle}>
      <span style={{ fontSize: 20 }}>{emoji}</span>
      <span>Installing...</span>
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
