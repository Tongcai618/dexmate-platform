import { useState } from 'react'
import { act, api, useApi } from '../lib/api'
import type { NewToken, Token } from '../lib/types'

const allScopes = ['data:read', 'data:write', 'label:write', 'model:write', 'forum:write']

export default function Tokens() {
  const { data: tokens, setData: setTokens, error: loadError } = useApi<Token[]>('/tokens')
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Token['kind']>('personal')
  const [scopes, setScopes] = useState<string[]>(['data:read'])
  const [revealed, setRevealed] = useState<string | null>(null)

  function create() {
    if (!name.trim() || scopes.length === 0) return
    act(setError, async () => {
      const res = await api<NewToken>('/tokens', { body: { name: name.trim(), kind, scopes } })
      setTokens((prev) => [res.token, ...(prev ?? [])])
      // Shown once; the server only keeps a hash.
      setRevealed(res.secret)
      setName('')
    })
  }

  function rotate(t: Token) {
    act(setError, async () => {
      const res = await api<NewToken>(`/tokens/${t.id}/rotate`, { method: 'POST' })
      setTokens((prev) => [res.token, ...(prev ?? []).map((x) => (x.id === t.id ? { ...x, revoked: true } : x))])
      setRevealed(res.secret)
    })
  }

  function revoke(t: Token) {
    act(setError, async () => {
      const updated = await api<Token>(`/tokens/${t.id}`, { method: 'DELETE' })
      setTokens((prev) => (prev ?? []).map((x) => (x.id === t.id ? updated : x)))
    })
  }

  const toggleScope = (s: string) => setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s])

  return (
    <>
      <header className="page-head">
        <h1>CLI & Tokens</h1>
        <p className="muted">Scoped tokens for the <code>dex</code> CLI. They go through the same permission checks as the web app, so they can't be used to get around them.</p>
      </header>

      <section className="card">
        <h3>New token</h3>
        <div className="row">
          <input placeholder="Token name, e.g. laptop-cli" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={kind} onChange={(e) => setKind(e.target.value as Token['kind'])}>
            <option value="personal">personal</option>
            <option value="service">service</option>
          </select>
          <button className="primary" onClick={create}>Create</button>
        </div>
        <div className="row scopes">
          {allScopes.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} /> {s}
            </label>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        {revealed && (
          <div className="reveal">
            <div className="small">Copy this token now. You won't be able to see it again.</div>
            <code>{revealed}</code>
            <pre>{`$ dex auth login --token ${revealed}\n$ curl -H "Authorization: Bearer ${revealed}" http://localhost:4000/api/events`}</pre>
          </div>
        )}
      </section>

      <section className="card">
        {loadError && <div className="error">{loadError}</div>}
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {(tokens ?? []).map((t) => (
              <tr key={t.id} className={t.revoked ? 'dim' : ''}>
                <td>{t.name}</td>
                <td><span className="pill">{t.kind}</span></td>
                <td>{t.scopes.map((s) => <code key={s} className="scope">{s}</code>)}</td>
                <td>{t.createdAt}</td>
                <td>{t.lastUsed ?? '—'}</td>
                <td><span className={t.revoked ? 'badge bad' : 'badge ok'}>{t.revoked ? 'revoked' : 'active'}</span></td>
                <td>
                  {!t.revoked && (
                    <div className="row">
                      <button className="link" onClick={() => rotate(t)}>Rotate</button>
                      <button className="link danger" onClick={() => revoke(t)}>Revoke</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
