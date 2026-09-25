import { useState } from 'react'
import { act, api, useApi } from '../lib/api'
import type { ModelVersion } from '../lib/types'

const stages: ModelVersion['stage'][] = ['training', 'staging', 'canary', 'prod']

export default function Models() {
  const { data, setData, error: loadError } = useApi<ModelVersion[]>('/models')
  const [error, setError] = useState('')
  const models = data ?? []

  // The server enforces the promotion gate and returns the updated board
  // (promoting to prod also archives the previous prod model of the same family).
  const move = (m: ModelVersion, action: 'promote' | 'rollback') =>
    act(setError, async () => setData(await api<ModelVersion[]>(`/models/${m.id}/${action}`, { method: 'POST' })))

  return (
    <>
      <header className="page-head">
        <h1>Models</h1>
        <p className="muted">Models move from staging to canary to prod. A model is only promoted if it passes the safety eval and does at least as well as the current prod model.</p>
      </header>

      {(loadError || error) && <div className="error">{loadError || error}</div>}
      <section className="board">
        {stages.map((s) => (
          <div key={s} className="column">
            <div className="column-head">{s}</div>
            {models.filter((m) => m.stage === s).map((m) => {
              const noAccess = m.canEdit ? null : `You need edit on ${m.project}`
              return (
                <div key={m.id} className="card model">
                  <div className="row between">
                    <b>{m.family} v{m.version}</b>
                    <span className="pill">{m.target}</span>
                  </div>
                  <div className="muted small">dataset: <code>{m.dataset}</code></div>
                  {m.stage !== 'training' ? (
                    <div className="small">
                      eval {m.metric.toFixed(3)} · safety {m.safetyPass ? '✓' : '✗'}
                    </div>
                  ) : (
                    <div className="progress"><div style={{ width: '60%' }} /></div>
                  )}
                  <div className="row">
                    {s !== 'prod' && (
                      <button className="primary small-btn" disabled={!!(m.blocked || noAccess)} title={m.blocked ?? noAccess ?? ''} onClick={() => move(m, 'promote')}>Promote</button>
                    )}
                    {s === 'canary' && <button className="small-btn" disabled={!!noAccess} title={noAccess ?? ''} onClick={() => move(m, 'rollback')}>Roll back</button>}
                  </div>
                  {m.blocked && s !== 'prod' && <div className="error small">{m.blocked}</div>}
                </div>
              )
            })}
          </div>
        ))}
      </section>
    </>
  )
}
