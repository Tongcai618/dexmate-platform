import { Router } from 'express'
import * as authz from '../authz.ts'
import { ORG, actions, relations } from '../authz.ts'
import { all, get, run } from '../db.ts'
import { HttpError, oneOf, ref } from '../http.ts'

const r = Router()

r.get('/relationships', (req, res) => {
  authz.require(req.principal, 'view', ORG, 'data:read')
  res.json(all('SELECT subject, relation, object FROM relationships ORDER BY rowid'))
})

r.post('/relationships', (req, res) => {
  authz.requireSession(req.principal)
  authz.require(req.principal, 'admin', ORG, 'data:read')
  const rel = { subject: ref(req.body, 'subject'), relation: oneOf(req.body, 'relation', relations), object: ref(req.body, 'object') }
  if (get('SELECT 1 FROM relationships WHERE subject = ? AND relation = ? AND object = ?', rel.subject, rel.relation, rel.object)) {
    throw new HttpError(409, 'That relationship already exists')
  }
  run('INSERT INTO relationships VALUES (?, ?, ?)', rel.subject, rel.relation, rel.object)
  authz.audit(req.principal, 'rel.write', `${rel.subject}#${rel.relation}@${rel.object}`, true)
  res.status(201).json(rel)
})

r.delete('/relationships', (req, res) => {
  authz.requireSession(req.principal)
  authz.require(req.principal, 'admin', ORG, 'data:read')
  const rel = { subject: ref(req.body, 'subject'), relation: oneOf(req.body, 'relation', relations), object: ref(req.body, 'object') }
  if (!get('SELECT 1 FROM relationships WHERE subject = ? AND relation = ? AND object = ?', rel.subject, rel.relation, rel.object)) {
    throw new HttpError(404, 'Relationship not found')
  }
  if (rel.relation === 'admin' && rel.object === ORG && get<{ n: number }>("SELECT COUNT(*) AS n FROM relationships WHERE relation = 'admin' AND object = ?", ORG)!.n <= 1) {
    throw new HttpError(409, `Can't remove the last admin of ${ORG}`)
  }
  run('DELETE FROM relationships WHERE subject = ? AND relation = ? AND object = ?', rel.subject, rel.relation, rel.object)
  authz.audit(req.principal, 'rel.delete', `${rel.subject}#${rel.relation}@${rel.object}`, true)
  res.status(204).end()
})

// Explain a permission decision, including the path through the graph.
r.get('/check', (req, res) => {
  authz.require(req.principal, 'view', ORG, 'data:read')
  const subject = ref(req.query, 'subject')
  const action = oneOf(req.query, 'action', actions)
  const object = ref(req.query, 'object')
  res.json(authz.check(subject, action, object))
})

r.get('/audit', (req, res) => {
  authz.require(req.principal, 'admin', ORG, 'data:read')
  res.json(all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'))
})

export default r
