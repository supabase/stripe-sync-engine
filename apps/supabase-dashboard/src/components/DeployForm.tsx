'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'

interface DeployFormProps {
  onDeploying: (deploying: boolean) => void
  onSuccess: (sessionId: string) => void
}

export function DeployForm({ onDeploying, onSuccess }: DeployFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    onDeploying(true)

    const formData = new FormData(e.currentTarget)
    const data = {
      supabaseAccessToken: formData.get('supabaseAccessToken') as string,
      supabaseProjectRef: formData.get('supabaseProjectRef') as string,
      stripeKey: formData.get('stripeKey') as string,
    }

    try {
      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Deployment failed')
      }

      onSuccess(result.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      onDeploying(false)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    border: '1px solid #ddd',
    borderRadius: 6,
    boxSizing: 'border-box' as const,
  }

  const labelStyle = {
    display: 'block',
    marginBottom: 6,
    fontWeight: 500,
    fontSize: 14,
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: 20 }}>
        <label style={labelStyle}>Supabase Access Token</label>
        <input
          type="password"
          name="supabaseAccessToken"
          required
          placeholder="sbp_..."
          style={inputStyle}
        />
        <p style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          Get from{' '}
          <Link
            style={{ color: '#3b82f6', textDecoration: 'none' }}
            href="https://supabase.com/dashboard/account/tokens"
            target="_blank"
          >
            supabase.com/dashboard/account/tokens
          </Link>
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={labelStyle}>Supabase Project Ref</label>
        <input
          type="text"
          name="supabaseProjectRef"
          required
          placeholder="abcdefghijklmnop"
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={labelStyle}>Stripe Secret Key</label>
        <input
          type="password"
          name="stripeKey"
          required
          placeholder="sk_... or rk_..."
          style={inputStyle}
        />
      </div>

      {error && (
        <div
          style={{
            padding: '10px 12px',
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 6,
            color: '#c00',
            marginBottom: 20,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        style={{
          width: '100%',
          padding: '12px',
          fontSize: 16,
          fontWeight: 600,
          background: loading ? '#999' : '#000',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Deploying...' : 'Deploy'}
      </button>
    </form>
  )
}
