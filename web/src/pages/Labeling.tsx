import { useState } from 'react'
import { act, api, useApi } from '../lib/api'
import type { LabelItem, User } from '../lib/types'

const REQUIRED_VOTES = 3

// Consensus: accepted once a choice has a strict majority of the required votes.
function consensus(item: LabelItem): string | null {
  const counts: Record<string, number> = {}
  for (const v of Object.values(item.votes)) counts[v] = (counts[v] ?? 0) + 1
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return top && top[1] > REQUIRED_VOTES / 2 ? top[0] : null
}

const header = (
  <header className="page-head">
    <h1>Labeling</h1>
    <p className="muted">Several people label each item. A label is accepted when a majority agree, and a model suggests a label first to speed things up.</p>
  </header>
)

export default function Labeling({ user }: { user: User }) {
  const { data: items, setData: setItems, error: loadError } = useApi<LabelItem[]>('/labels')
  const [idx, setIdx] = useState(0)
  const [error, setError] = useState('')

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <section className="card">
          {loadError ? <div className="error">{loadError}</div> : <div className="muted">{items ? 'Your queue is empty.' : 'Loading…'}</div>}
        </section>
      </>
    )
  }

  const cur = Math.min(idx, items.length - 1)
  const item = items[cur]
  const myVote = item.votes[user.id]
  const agreed = consensus(item)

  function select(i: number) {
    setIdx(i)
    setError('')
  }

  function vote(choice: string) {
    act(setError, async () => {
      const updated = await api<LabelItem>(`/labels/${item.id}/vote`, { body: { choice } })
      setItems((prev) => (prev ?? []).map((it) => (it.id === updated.id ? updated : it)))
    })
  }

  return (
    <>
      {header}

      <div className="label-layout">
        <section className="card queue">
          <h3>Queue</h3>
          {items.map((it, i) => (
            <button key={it.id} className={i === cur ? 'queue-item active' : 'queue-item'} onClick={() => select(i)}>
              <span className="pill">{it.modality}</span>
              <span className="truncate">{it.content}</span>
              <span className="muted small">{Object.keys(it.votes).length}/{REQUIRED_VOTES}</span>
            </button>
          ))}
        </section>

        <section className="card task">
          <div className="row between">
            <span className="pill">{item.modality}</span>
            <span className="muted small">{item.id}</span>
          </div>
          <div className="task-content">{item.content}</div>
          {item.prelabel && <div className="muted small">🤖 Model suggestion: <b>{item.prelabel}</b></div>}

          <div className="choices">
            {item.options.map((o) => (
              <button key={o} className={myVote === o ? 'choice selected' : 'choice'} disabled={!item.canLabel} onClick={() => vote(o)}>{o}</button>
            ))}
          </div>
          {!item.canLabel && <div className="muted small">You can view this item but not label it (needs <code>label</code> on <code>{item.project}</code>).</div>}
          {error && <div className="error">{error}</div>}

          <div className="votes">
            <h4>Votes</h4>
            {Object.entries(item.votes).length === 0 && <div className="muted small">No votes yet.</div>}
            {Object.entries(item.votes).map(([who, v]) => (
              <div key={who} className="small"><b>{who}</b> → {v}</div>
            ))}
          </div>

          <div className={agreed ? 'badge ok' : 'badge warn'}>
            {agreed ? `Consensus: ${agreed}` : `Needs more votes (${Object.keys(item.votes).length}/${REQUIRED_VOTES})`}
          </div>

          <div className="row between">
            <button disabled={cur === 0} onClick={() => select(cur - 1)}>← Prev</button>
            <button disabled={cur === items.length - 1} onClick={() => select(cur + 1)}>Next →</button>
          </div>
        </section>
      </div>
    </>
  )
}
