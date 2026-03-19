// Session store that persists across hot reloads in development
interface Session {
  projectRef: string
  accessToken: string
  createdAt: number
}

// Use global to persist across hot reloads in development
const globalForSessions = globalThis as unknown as {
  sessions: Map<string, Session> | undefined
}

const sessions = globalForSessions.sessions ?? new Map<string, Session>()

if (process.env.NODE_ENV !== 'production') {
  globalForSessions.sessions = sessions
}

// Clean up sessions older than 1 hour
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.createdAt > 60 * 60 * 1000) {
        sessions.delete(id)
      }
    }
  }, 60 * 1000)
}

export function createSession(projectRef: string, accessToken: string): string {
  const id = crypto.randomUUID()
  sessions.set(id, { projectRef, accessToken, createdAt: Date.now() })
  return id
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}
