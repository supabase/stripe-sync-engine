'use client'

import { useState } from 'react'
import { DeployForm } from '@/components/DeployForm'
import { SyncStatus } from '@/components/SyncStatus'

export default function Home() {
  const [deploying, setDeploying] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: 40 }}>
      <h1 style={{ marginBottom: 8 }}>Stripe Sync</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Deploy Stripe sync to your Supabase project</p>

      <DeployForm
        onDeploying={setDeploying}
        onSuccess={(id) => {
          setDeploying(false)
          setSessionId(id)
        }}
      />

      <div style={{ marginTop: 32 }}>
        {deploying && (
          <div style={statusStyle}>
            <span style={{ fontSize: 20 }}>🚀</span>
            <span>Deploying...</span>
          </div>
        )}

        {!deploying && sessionId && <SyncStatus sessionId={sessionId} />}
      </div>
    </main>
  )
}

const statusStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '16px 20px',
  background: '#f0f7ff',
  borderRadius: 8,
  fontSize: 16,
}
