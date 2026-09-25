import { Router } from 'express'
import * as authz from '../authz.ts'
import { ORG } from '../authz.ts'
import { randomId } from '../crypto.ts'
import { all, get, now, run, tx } from '../db.ts'
import { HttpError, str } from '../http.ts'
import { ingest } from './data.ts'

type TopicRow = { id: string; category: string; title: string; author: string; created_at: string }
type ReplyRow = { id: string; topic_id: string; author: string; body: string; accepted: number; votes: number; voted: number }

function topicToApi(t: TopicRow, userId: string) {
  const replies = all<ReplyRow>(
    `SELECT r.*,
       (SELECT COUNT(*) FROM reply_votes v WHERE v.reply_id = r.id) AS votes,
       EXISTS (SELECT 1 FROM reply_votes v WHERE v.reply_id = r.id AND v.user_id = ?) AS voted
     FROM replies r WHERE r.topic_id = ? AND r.deleted_at IS NULL ORDER BY r.created_at, r.rowid`, userId, t.id)
  return {
    id: t.id, category: t.category, title: t.title, author: t.author,
    replies: replies.map((r) => ({ id: r.id, author: r.author, body: r.body, accepted: !!r.accepted, votes: r.votes, voted: !!r.voted })),
  }
}

function loadTopic(id: string) {
  const t = get<TopicRow>('SELECT * FROM topics WHERE id = ?', id)
  if (!t) throw new HttpError(404, 'Topic not found')
  return t
}

function loadReply(id: string) {
  const r = get<ReplyRow>('SELECT * FROM replies WHERE id = ? AND deleted_at IS NULL', id)
  if (!r) throw new HttpError(404, 'Reply not found')
  return r
}

// The forum is open to every signed-in user; tokens need the matching scope.
const r = Router()

r.get('/topics', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  res.json(all<TopicRow>('SELECT * FROM topics ORDER BY created_at DESC').map((t) => topicToApi(t, req.principal.userId)))
})

r.get('/topics/:id', (req, res) => {
  authz.requireScope(req.principal, 'data:read')
  res.json(topicToApi(loadTopic(req.params.id), req.principal.userId))
})

r.post('/topics', (req, res) => {
  authz.requireScope(req.principal, 'forum:write')
  const id = randomId('t')
  run('INSERT INTO topics VALUES (?, ?, ?, ?, ?)', id, str(req.body, 'category', 40), str(req.body, 'title', 200), req.principal.userId, now())
  res.status(201).json(topicToApi(loadTopic(id), req.principal.userId))
})

r.post('/topics/:id/replies', (req, res) => {
  authz.requireScope(req.principal, 'forum:write')
  const t = loadTopic(req.params.id)
  run('INSERT INTO replies (id, topic_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
    randomId('r'), t.id, req.principal.userId, str(req.body, 'body', 5000), now())
  res.status(201).json(topicToApi(t, req.principal.userId))
})

// One vote per user per reply; voting again is a no-op. Votes are preference labels,
// so self-votes are rejected to keep that signal clean.
r.post('/replies/:id/vote', (req, res) => {
  authz.requireScope(req.principal, 'forum:write')
  const reply = loadReply(req.params.id)
  if (reply.author === req.principal.userId) throw new HttpError(409, "You can't vote on your own reply")
  run('INSERT OR IGNORE INTO reply_votes VALUES (?, ?)', reply.id, req.principal.userId)
  res.json(topicToApi(loadTopic(reply.topic_id), req.principal.userId))
})

// Only the topic author can accept; the accepted pair becomes a labeled QA example.
r.post('/replies/:id/accept', (req, res) => {
  authz.requireScope(req.principal, 'forum:write')
  const reply = loadReply(req.params.id)
  const t = loadTopic(reply.topic_id)
  if (t.author !== req.principal.userId) throw new HttpError(403, 'Only the topic author can accept a solution')
  if (reply.accepted) return void res.json(topicToApi(t, req.principal.userId))
  tx(() => {
    run('UPDATE replies SET accepted = (id = ?) WHERE topic_id = ?', reply.id, t.id)
    ingest({ source: 'forum', type: 'forum.accepted_answer', project: ORG, consent: true, payload: { topic: t.id, reply: reply.id }, by: authz.subjectOf(req.principal) })
  })
  res.json(topicToApi(t, req.principal.userId))
})

// Moderation: org admins can remove replies (soft delete, audited).
r.delete('/replies/:id', (req, res) => {
  authz.requireSession(req.principal)
  const reply = loadReply(req.params.id)
  authz.require(req.principal, 'admin', ORG, 'forum:write')
  run('UPDATE replies SET deleted_at = ?, accepted = 0 WHERE id = ?', now(), reply.id)
  res.json(topicToApi(loadTopic(reply.topic_id), req.principal.userId))
})

export default r
