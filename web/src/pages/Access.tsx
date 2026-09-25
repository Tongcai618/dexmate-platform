import { useEffect, useState } from 'react'
import { act, api, useApi } from '../lib/api'
import type { Action, CheckResult, Relationship } from '../lib/types'

export default function Access() {
  const { data: rels, error: loadError, reload } = useApi<Relationship[]>('/relationships')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Relationship>({ subject: 'user:bob', relation: 'viewer', object: 'project:motion' })
  const [q, setQ] = useState({ subject: 'user:carol', action: 'label' as Action, object: 'project:voice' })
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checkError, setCheckError] = useState('')

  // Ask the server (debounced as you type); re-run whenever the graph changes.
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api<CheckResult>(`/check?${new URLSearchParams(q)}`).then(
        (r) => {
          if (!live) return
          setResult(r)
          setCheckError('')
        },
        (e: Error) => {
          if (!live) return
          setResult(null)
          setCheckError(e.message)
        },
      )
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, rels])

  function add() {
    if (!draft.subject || !draft.object) return
    act(setError, async () => {
      await api('/relationships', { body: draft })
      reload()
    })
  }

  function remove(r: Relationship) {
    act(setError, async () => {
      await api('/relationships', { method: 'DELETE', body: r })
      reload()
    })
  }

  return (
    <>
      <header className="page-head">
        <h1>Access</h1>
        <p className="muted">Relationship-based access control. Permissions come from relationships at a scope, never from role strings.</p>
      </header>

      {loadError ? (
        <section className="card"><div className="error">{loadError}</div></section>
      ) : (
        <>
          <section className="card">
            <h3>Permission check</h3>
            <div className="row">
              <input value={q.subject} onChange={(e) => setQ({ ...q, subject: e.target.value })} />
              <span className="muted">can</span>
              <select value={q.action} onChange={(e) => setQ({ ...q, action: e.target.value as Action })}>
                {['view', 'label', 'edit', 'admin'].map((a) => <option key={a}>{a}</option>)}
              </select>
              <input value={q.object} onChange={(e) => setQ({ ...q, object: e.target.value })} />
              {result && <span className={result.allowed ? 'badge ok' : 'badge bad'}>{result.allowed ? 'ALLOWED' : 'DENIED'}</span>}
            </div>
            {checkError && <div className="error">{checkError}</div>}
            {result?.allowed && (
              <div className="path">
                <span className="muted small">Resolved via:</span>
                {result.path.map((p) => <code key={p}>{p}</code>)}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Relationships</h3>
            <table>
              <thead><tr><th>Subject</th><th>Relation</th><th>Object</th><th></th></tr></thead>
              <tbody>
                {(rels ?? []).map((r) => (
                  <tr key={`${r.subject}#${r.relation}@${r.object}`}>
                    <td><code>{r.subject}</code></td>
                    <td><span className="pill">{r.relation}</span></td>
                    <td><code>{r.object}</code></td>
                    <td><button className="link danger" onClick={() => remove(r)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row add-row">
              <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="user:alice" />
              <select value={draft.relation} onChange={(e) => setDraft({ ...draft, relation: e.target.value })}>
                {['admin', 'owner', 'labeler', 'viewer', 'parent'].map((r) => <option key={r}>{r}</option>)}
              </select>
              <input value={draft.object} onChange={(e) => setDraft({ ...draft, object: e.target.value })} placeholder="project:voice" />
              <button className="primary" onClick={add}>Add</button>
            </div>
            {error && <div className="error">{error}</div>}
          </section>
        </>
      )}
    </>
  )
}
