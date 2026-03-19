import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/sessions'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })
    }

    const session = getSession(sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 })
    }

    // Use Supabase Management API to run SQL (bypasses PostgREST schema restrictions)
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${session.projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `
            SELECT
              account_id,
              started_at,
              closed_at,
              status,
              error_message,
              total_processed
            FROM stripe.sync_runs
            ORDER BY started_at DESC
            LIMIT 1
          `,
        }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      return NextResponse.json({ error: `Database query failed: ${text}` }, { status: 500 })
    }

    const result = await response.json()

    // Result is array of rows
    const syncRun = result && result.length > 0 ? result[0] : null

    return NextResponse.json({ syncRun })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
