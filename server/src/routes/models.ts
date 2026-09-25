import { Router } from 'express'
import * as authz from '../authz.ts'
import type { Principal } from '../authz.ts'
import { randomId } from '../crypto.ts'
import { all, get, run, tx } from '../db.ts'
import { HttpError, oneOf, str } from '../http.ts'

type Stage = 'training' | 'staging' | 'canary' | 'prod' | 'archived'
type ModelRow = { id: string; family: string; project: string; version: number; stage: Stage; dataset: string; metric: number; safety_pass: number; target: string }

const stages: Stage[] = ['training', 'staging', 'canary', 'prod']
const families = ['llm', 'voice', 'motion'] as const
// Each model family is owned by a project in the access graph.
const familyProject: Record<(typeof families)[number], string> = { voice: 'project:voice', motion: 'project:motion', llm: authz.ORG }

// Promotion gate: must pass safety eval and at least match the current prod metric for its family.
export function gate(m: ModelRow): string | null {
  if (m.stage === 'training') return 'Still training'
  if (m.stage === 'prod' || m.stage === 'archived') return `Cannot promote from ${m.stage}`
  if (!m.safety_pass) return 'Failed safety eval'
  const prod = get<ModelRow>("SELECT * FROM models WHERE family = ? AND stage = 'prod'", m.family)
  if (prod && m.metric < prod.metric) return `Below prod (${prod.metric.toFixed(3)})`
  if (m.stage === 'staging' && get("SELECT 1 FROM models WHERE family = ? AND stage = 'canary'", m.family)) return 'Another canary is running'
  return null
}

function load(id: string) {
  const m = get<ModelRow>('SELECT * FROM models WHERE id = ?', id)
  if (!m) throw new HttpError(404, 'Model not found')
  return m
}

const list = (p: Principal) =>
  authz.visible(p, all<ModelRow>('SELECT * FROM models ORDER BY family, version')).map((m) => ({
    id: m.id, family: m.family, project: m.project, version: m.version, stage: m.stage,
    dataset: m.dataset, metric: m.metric, safetyPass: !!m.safety_pass, target: m.target,
    blocked: gate(m),
    canEdit: authz.can(p, 'edit', m.project, 'model:write'),
  }))

const r = Router()

r.get('/', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  res.json(list(req.principal))
})

// Register a training run (called by the training pipeline, usually with a service token).
r.post('/', (req, res) => {
  const family = oneOf(req.body, 'family', families)
  const project = familyProject[family]
  authz.require(req.principal, 'edit', project, 'model:write')
  const id = randomId('m')
  const version = (get<{ v: number | null }>('SELECT MAX(version) AS v FROM models WHERE family = ?', family)!.v ?? 0) + 1
  run('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, family, project, version, 'training',
    str(req.body, 'dataset', 100), 0, 0, oneOf(req.body, 'target', ['cloud', 'edge'] as const))
  res.status(201).json(list(req.principal))
})

// Report golden-set + safety eval results; moves the run from training to staging.
r.post('/:id/eval', (req, res) => {
  const m = load(req.params.id)
  authz.require(req.principal, 'edit', m.project, 'model:write')
  if (m.stage !== 'training') throw new HttpError(409, 'Only training runs can report eval results')
  const { metric, safetyPass } = req.body ?? {}
  if (typeof metric !== 'number' || metric < 0 || metric > 1) throw new HttpError(400, '"metric" must be a number between 0 and 1')
  if (typeof safetyPass !== 'boolean') throw new HttpError(400, '"safetyPass" must be true or false')
  run("UPDATE models SET stage = 'staging', metric = ?, safety_pass = ? WHERE id = ?", metric, safetyPass ? 1 : 0, m.id)
  authz.audit(req.principal, 'model.eval', `model:${m.id}`, true, { metric, safetyPass })
  res.json(list(req.principal))
})

// Returns the full list since promoting to prod also archives the previous prod model.
r.post('/:id/promote', (req, res) => {
  const m = load(req.params.id)
  authz.require(req.principal, 'edit', m.project, 'model:write')
  const blocked = gate(m)
  if (blocked) throw new HttpError(409, blocked)
  const next = stages[stages.indexOf(m.stage) + 1]
  tx(() => {
    if (next === 'prod') run("UPDATE models SET stage = 'archived' WHERE family = ? AND stage = 'prod'", m.family)
    run('UPDATE models SET stage = ? WHERE id = ?', next, m.id)
  })
  authz.audit(req.principal, 'model.promote', `model:${m.id}`, true, { from: m.stage, to: next })
  res.json(list(req.principal))
})

r.post('/:id/rollback', (req, res) => {
  const m = load(req.params.id)
  authz.require(req.principal, 'edit', m.project, 'model:write')
  if (m.stage !== 'canary') throw new HttpError(409, 'Only canary models can be rolled back')
  run("UPDATE models SET stage = 'archived' WHERE id = ?", m.id)
  authz.audit(req.principal, 'model.rollback', `model:${m.id}`, true)
  res.json(list(req.principal))
})

export default r
