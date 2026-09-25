import { Router } from 'express'
import * as authz from '../authz.ts'
import type { Principal } from '../authz.ts'
import { randomId } from '../crypto.ts'
import { all, get, now, run } from '../db.ts'
import { HttpError, oneOf, ref, str } from '../http.ts'

// --- Events (collection → PII scrub → bronze → silver → gold) ---

type EventRow = { id: string; ts: string; source: string; type: string; project: string; consent: number; pii_scrubbed: number; layer: string; payload: string }

const sources = ['app', 'robot', 'agent', 'forum'] as const
const layers = ['bronze', 'silver', 'gold'] as const

const eventToApi = (e: EventRow) => ({
  id: e.id, ts: e.ts, source: e.source, type: e.type, project: e.project,
  consent: !!e.consent, piiScrubbed: !!e.pii_scrubbed, layer: e.layer, payload: e.payload,
})

// Redacts emails and phone numbers in free-text fields before anything lands in the lake.
// Only strings are scrubbed, so numeric telemetry (timestamps, ids) passes through intact.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g

export function scrubPii(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, '[REDACTED]').replace(PHONE, '[REDACTED]')
  if (Array.isArray(value)) return value.map(scrubPii)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubPii(v)]))
  return value
}

// Shared ingest path; other services (e.g. the forum) call it directly.
export function ingest(e: { source: string; type: string; project: string; consent: boolean; payload: unknown; by: string }) {
  const id = randomId('ev')
  const ts = now().replace('T', ' ').slice(0, 19)
  const payload = e.consent ? JSON.stringify(scrubPii(e.payload ?? {})) : '(dropped: no consent)'
  run('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, ts, e.source, e.type, e.project, e.consent ? 1 : 0, e.consent ? 1 : 0, 'bronze', payload, e.by)
  return get<EventRow>('SELECT * FROM events WHERE id = ?', id)!
}

export const events = Router()

events.get('/', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  const where: string[] = []
  const params: string[] = []
  if (req.query.source) {
    where.push('source = ?')
    params.push(oneOf(req.query, 'source', sources))
  }
  if (req.query.layer) {
    where.push('layer = ?')
    params.push(oneOf(req.query, 'layer', layers))
  }
  const rows = all<EventRow>(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC`, ...params)
  res.json(authz.visible(req.principal, rows).map(eventToApi))
})

events.post('/', (req, res) => {
  const project = ref(req.body, 'project')
  authz.require(req.principal, 'edit', project, 'data:write')
  if (typeof req.body?.consent !== 'boolean') throw new HttpError(400, '"consent" must be true or false')
  const e = ingest({
    source: oneOf(req.body, 'source', sources),
    type: str(req.body, 'type', 100),
    project,
    consent: req.body.consent,
    payload: req.body.payload,
    by: authz.subjectOf(req.principal),
  })
  res.status(201).json(eventToApi(e))
})

// Promotion needs consent + scrubbing; quality gates would plug in here too.
events.post('/:id/promote', (req, res) => {
  const e = get<EventRow>('SELECT * FROM events WHERE id = ?', req.params.id)
  if (!e) throw new HttpError(404, 'Event not found')
  authz.require(req.principal, 'edit', e.project, 'data:write')
  if (!e.consent || !e.pii_scrubbed) throw new HttpError(409, 'Events without consent or PII scrubbing cannot be promoted')
  const next = layers[layers.indexOf(e.layer as (typeof layers)[number]) + 1]
  if (!next) throw new HttpError(409, 'Event is already gold')
  run('UPDATE events SET layer = ? WHERE id = ?', next, e.id)
  res.json(eventToApi({ ...e, layer: next }))
})

// --- Labeling (consensus voting with model pre-labels) ---

type ItemRow = { id: string; modality: string; project: string; content: string; options: string; prelabel: string | null }

export const REQUIRED_VOTES = 3

function itemToApi(i: ItemRow, p: Principal) {
  const votes: Record<string, string> = {}
  for (const v of all<{ user_id: string; choice: string }>('SELECT user_id, choice FROM label_votes WHERE item_id = ? ORDER BY rowid', i.id)) votes[v.user_id] = v.choice
  return { id: i.id, modality: i.modality, project: i.project, content: i.content, options: JSON.parse(i.options) as string[], votes, prelabel: i.prelabel,
    canLabel: authz.can(p, 'label', i.project, 'label:write') }
}

export const labels = Router()

labels.get('/', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  res.json(authz.visible(req.principal, all<ItemRow>('SELECT * FROM label_items ORDER BY id')).map((i) => itemToApi(i, req.principal)))
})

labels.post('/:id/vote', (req, res) => {
  const item = get<ItemRow>('SELECT * FROM label_items WHERE id = ?', req.params.id)
  if (!item) throw new HttpError(404, 'Item not found')
  authz.require(req.principal, 'label', item.project, 'label:write')
  const choice = oneOf(req.body, 'choice', JSON.parse(item.options) as string[])
  run('INSERT INTO label_votes VALUES (?, ?, ?) ON CONFLICT (item_id, user_id) DO UPDATE SET choice = excluded.choice', item.id, req.principal.userId, choice)
  res.json(itemToApi(item, req.principal))
})
