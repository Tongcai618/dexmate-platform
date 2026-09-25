import { useState } from 'react'
import { useApi } from '../lib/api'
import type { IngestEvent } from '../lib/types'

const layers: IngestEvent['layer'][] = ['bronze', 'silver', 'gold']

export default function Data() {
  const { data, error } = useApi<IngestEvent[]>('/events')
  const [source, setSource] = useState<string>('all')
  const [layer, setLayer] = useState<string>('all')

  const events = data ?? []
  const rows = events.filter((e) => (source === 'all' || e.source === source) && (layer === 'all' || e.layer === layer))

  return (
    <>
      <header className="page-head">
        <h1>Data Collection</h1>
        <p className="muted">Each event is checked for consent, scrubbed of personal data, stamped with where it came from, and then moved from bronze (raw) to silver (cleaned) to gold (ready for training).</p>
      </header>

      <section className="stats">
        {layers.map((l) => (
          <div key={l} className={`card stat layer-${l}`}>
            <div className="muted small">{l}</div>
            <div className="stat-value">{events.filter((e) => e.layer === l).length}</div>
          </div>
        ))}
        <div className="card stat">
          <div className="muted small">dropped (no consent)</div>
          <div className="stat-value">{events.filter((e) => !e.consent).length}</div>
        </div>
      </section>

      <section className="card">
        {error && <div className="error">{error}</div>}
        <div className="row">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All sources</option>
            {['app', 'robot', 'agent', 'forum'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={layer} onChange={(e) => setLayer(e.target.value)}>
            <option value="all">All layers</option>
            {layers.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        <table>
          <thead><tr><th>Time</th><th>Source</th><th>Type</th><th>Consent</th><th>PII scrubbed</th><th>Layer</th><th>Payload</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={e.consent ? '' : 'dim'}>
                <td className="small">{e.ts}</td>
                <td><span className="pill">{e.source}</span></td>
                <td><code>{e.type}</code></td>
                <td>{e.consent ? '✓' : '✗'}</td>
                <td>{e.piiScrubbed ? '✓' : '—'}</td>
                <td><span className={`pill layer-${e.layer}`}>{e.layer}</span></td>
                <td><code className="small">{e.payload}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
