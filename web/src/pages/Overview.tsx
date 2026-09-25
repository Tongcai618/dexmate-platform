import { useApi } from '../lib/api'
import type { OverviewStats, User } from '../lib/types'

// The flywheel: each stage feeds the next, and serving feeds back into collection.
const stages = [
  { name: 'Collect', desc: 'Events → PII scrub → bronze' },
  { name: 'Label', desc: 'Consensus + active learning' },
  { name: 'Version', desc: 'bronze → silver → gold' },
  { name: 'Train', desc: 'Eval-gated promotion' },
  { name: 'Serve', desc: 'Canary → prod, cloud + edge' },
]

const show = (n: number | undefined) => (n === undefined ? '—' : n.toString())

export default function Overview({ user }: { user: User }) {
  const { data: stats, error } = useApi<OverviewStats>('/overview')

  return (
    <>
      <header className="page-head">
        <h1>Welcome back, {user.name.split(' ')[0]}</h1>
        <p className="muted">Production usage becomes tomorrow's training set.</p>
      </header>

      {error && <div className="error">{error}</div>}
      <section className="stats">
        <Stat label="Events ingested" value={show(stats?.events)} sub={stats ? `${stats.eventsToday} today` : undefined} />
        <Stat label="Items awaiting labels" value={show(stats?.pendingLabels)} />
        <Stat label="Models in prod" value={show(stats?.inProd)} sub={stats ? `${stats.canary} in canary` : undefined} />
        <Stat label="Forum topics" value={show(stats?.topics)} />
      </section>

      <section className="card">
        <h3>Data flywheel</h3>
        <div className="flywheel">
          {stages.map((s, i) => (
            <div key={s.name} className="stage-wrap">
              <div className="stage">
                <div className="stage-num">{i + 1}</div>
                <div className="stage-name">{s.name}</div>
                <div className="muted small">{s.desc}</div>
              </div>
              {i < stages.length - 1 && <div className="arrow">→</div>}
            </div>
          ))}
        </div>
        <div className="loopback">↺ every inference is traced and sampled back into Collect</div>
      </section>
    </>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  )
}
