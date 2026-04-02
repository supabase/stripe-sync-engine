import { useState, useEffect } from 'react'
import { PipelineList } from './pages/PipelineList'
import { PipelineCreate } from './pages/PipelineCreate'
import { PipelineDetail } from './pages/PipelineDetail'

type Page = { view: 'list' } | { view: 'create' } | { view: 'detail'; id: string }

function parsePath(path: string): Page {
  if (path === '/create') return { view: 'create' }
  const match = path.match(/^\/pipelines\/(.+)$/)
  if (match) return { view: 'detail', id: match[1] }
  return { view: 'list' }
}

function toPath(page: Page): string {
  if (page.view === 'create') return '/create'
  if (page.view === 'detail') return `/pipelines/${page.id}`
  return '/'
}

export default function App() {
  const [page, setPage] = useState<Page>(() => parsePath(window.location.pathname))

  useEffect(() => {
    const onPop = () => setPage(parsePath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(p: Page) {
    const path = toPath(p)
    if (path !== window.location.pathname) {
      window.history.pushState(null, '', path)
    }
    setPage(p)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white px-8 py-4">
        <button
          onClick={() => navigate({ view: 'list' })}
          className="text-lg font-semibold text-gray-900 hover:text-indigo-600"
        >
          Stripe Sync
        </button>
      </header>
      <main>
        {page.view === 'list' && (
          <PipelineList
            onSelect={(id) => navigate({ view: 'detail', id })}
            onCreate={() => navigate({ view: 'create' })}
          />
        )}
        {page.view === 'create' && <PipelineCreate onDone={() => navigate({ view: 'list' })} />}
        {page.view === 'detail' && (
          <PipelineDetail id={page.id} onBack={() => navigate({ view: 'list' })} />
        )}
      </main>
    </div>
  )
}
