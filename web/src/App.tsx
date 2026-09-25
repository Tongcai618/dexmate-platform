import { useEffect, useState } from 'react'
import { api, hasSession, onSessionExpired, setSession } from './lib/api'
import type { User } from './lib/types'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Access from './pages/Access'
import Tokens from './pages/Tokens'
import Data from './pages/Data'
import Labeling from './pages/Labeling'
import Models from './pages/Models'
import Forum from './pages/Forum'

const pages = [
  { key: 'overview', label: 'Overview', group: '', el: Overview },
  { key: 'access', label: 'Access (ReBAC)', group: 'Control plane', el: Access },
  { key: 'tokens', label: 'CLI & Tokens', group: 'Control plane', el: Tokens },
  { key: 'data', label: 'Data Collection', group: 'Data plane', el: Data },
  { key: 'labeling', label: 'Labeling', group: 'Data plane', el: Labeling },
  { key: 'models', label: 'Models', group: 'Model plane', el: Models },
  { key: 'forum', label: 'Forum', group: 'Agent plane', el: Forum },
] as const

type PageKey = (typeof pages)[number]['key']

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  // Restoring a saved session: wait for /auth/me before choosing login vs. app.
  const [restoring, setRestoring] = useState(hasSession)
  const [page, setPage] = useState<PageKey>('overview')

  useEffect(() => {
    onSessionExpired(() => setUser(null))
    if (!hasSession()) return
    api<User>('/auth/me')
      .then(setUser, () => setSession(null))
      .finally(() => setRestoring(false))
  }, [])

  function signOut() {
    api('/auth/logout', { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        setSession(null)
        setUser(null)
        setPage('overview')
      })
  }

  if (restoring) return null
  if (!user) {
    return (
      <Login
        onLogin={(u, token) => {
          setSession(token)
          setUser(u)
        }}
      />
    )
  }

  const Current = pages.find((p) => p.key === page)!.el
  let lastGroup = ''

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">dexmate<span>.platform</span></div>
        <nav>
          {pages.map((p) => {
            const header = p.group && p.group !== lastGroup ? <div className="nav-group">{p.group}</div> : null
            lastGroup = p.group
            return (
              <div key={p.key}>
                {header}
                <button className={page === p.key ? 'nav-item active' : 'nav-item'} onClick={() => setPage(p.key)}>
                  {p.label}
                </button>
              </div>
            )
          })}
        </nav>
        <div className="me">
          <div className="avatar">{user.name[0]}</div>
          <div>
            <div>{user.name}</div>
            <button className="link" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>
      <main className="content">
        <Current user={user} />
      </main>
    </div>
  )
}
