import { Router } from 'express'
import * as authz from '../authz.ts'
import { all, get, today } from '../db.ts'
import { REQUIRED_VOTES } from './data.ts'

const r = Router()

// Dashboard counts, scoped to what the caller can see.
r.get('/', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  const p = req.principal
  const events = authz.visible(p, all<{ project: string; ts: string }>('SELECT project, ts FROM events'))
  const items = authz.visible(p, all<{ project: string; votes: number }>(
    'SELECT i.project, (SELECT COUNT(*) FROM label_votes v WHERE v.item_id = i.id) AS votes FROM label_items i'))
  const models = authz.visible(p, all<{ project: string; stage: string }>('SELECT project, stage FROM models'))

  res.json({
    events: events.length,
    eventsToday: events.filter((e) => e.ts.startsWith(today())).length,
    pendingLabels: items.filter((i) => i.votes < REQUIRED_VOTES).length,
    inProd: models.filter((m) => m.stage === 'prod').length,
    canary: models.filter((m) => m.stage === 'canary').length,
    topics: get<{ n: number }>('SELECT COUNT(*) AS n FROM topics')!.n,
  })
})

export default r
