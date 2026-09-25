import { Router } from 'express'
import { authenticate, signMfa, signSession, verify } from '../auth.ts'
import { audit, requireSession } from '../authz.ts'
import { randomId, verifyPassword, verifyTotp } from '../crypto.ts'
import { all, get, now, run, tx } from '../db.ts'
import { HttpError, rateLimit, str } from '../http.ts'

type UserRow = { id: string; name: string; email: string; password_hash: string; totp_secret: string; totp_last_step: number }

export const publicUser = (u: { id: string; name: string; email: string }) => ({ id: u.id, name: u.name, email: u.email })

const r = Router()
const perIp = rateLimit((req) => `auth:${req.ip}`, Number(process.env.AUTH_RATE_LIMIT ?? 20))

// Demo only: accept a fixed MFA code (e.g. DEMO_MFA_CODE=123456). Ignored in production.
const demoMfaCode = process.env.NODE_ENV === 'production' ? undefined : process.env.DEMO_MFA_CODE
if (demoMfaCode) console.warn('DEMO_MFA_CODE is set; a fixed MFA code is accepted for every user.')

// Step 1: password. Returns a short-lived MFA challenge, never a session.
r.post('/login', perIp, (req, res) => {
  const email = str(req.body, 'email').toLowerCase()
  const password = str(req.body, 'password')
  const user = get<UserRow>('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', email)
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(`email:${email}`, 'auth.login', 'password', false)
    throw new HttpError(401, 'Invalid email or password')
  }
  res.json({ mfaToken: signMfa(user.id) })
})

// Step 2: TOTP. Each code can be used once.
r.post('/mfa', perIp, (req, res) => {
  const claims = verify(str(req.body, 'mfaToken', 2000), 'mfa')
  const code = str(req.body, 'code', 6)
  const user = get<UserRow>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', claims.sub)
  if (!user) throw new HttpError(401, 'Sign-in expired, start again')

  let step: number | null
  if (demoMfaCode && code === demoMfaCode) {
    step = user.totp_last_step
  } else {
    step = /^\d{6}$/.test(code) ? verifyTotp(user.totp_secret, code) : null
    if (step === null || step <= user.totp_last_step) {
      audit(`user:${user.id}`, 'auth.mfa', 'totp', false)
      throw new HttpError(401, 'That code is invalid or has already been used')
    }
  }

  const sid = randomId('ses')
  tx(() => {
    run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id)
    run('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)', sid, user.id, now())
  })
  audit(`user:${user.id}`, 'auth.login', `session:${sid}`, true)
  res.json({ token: signSession(user.id, sid), user: publicUser(user) })
})

r.post('/sso', () => {
  throw new HttpError(501, 'SSO needs a WorkOS connection configured on the server')
})

r.use(authenticate)

r.get('/me', (req, res) => {
  res.json(publicUser(get<UserRow>('SELECT * FROM users WHERE id = ?', req.principal.userId)!))
})

r.post('/logout', (req, res) => {
  if (req.principal.sessionId) run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), req.principal.sessionId)
  res.status(204).end()
})

r.get('/sessions', (req, res) => {
  requireSession(req.principal)
  const rows = all<{ id: string; created_at: string }>(
    'SELECT id, created_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', req.principal.userId)
  res.json(rows.map((s) => ({ id: s.id, createdAt: s.created_at, current: s.id === req.principal.sessionId })))
})

r.delete('/sessions/:id', (req, res) => {
  requireSession(req.principal)
  const out = run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), req.params.id, req.principal.userId)
  if (!out.changes) throw new HttpError(404, 'Session not found')
  audit(req.principal, 'auth.session.revoke', `session:${req.params.id}`, true)
  res.status(204).end()
})

// GDPR export: everything we hold that was authored by this user.
r.get('/export', (req, res) => {
  requireSession(req.principal)
  const id = req.principal.userId
  audit(req.principal, 'gdpr.export', `user:${id}`, true)
  res.json({
    user: publicUser(get<UserRow>('SELECT * FROM users WHERE id = ?', id)!),
    relationships: all('SELECT * FROM relationships WHERE subject = ?', `user:${id}`),
    tokens: all('SELECT id, name, kind, scopes, created_at, last_used, revoked_at FROM tokens WHERE user_id = ?', id),
    labelVotes: all('SELECT item_id, choice FROM label_votes WHERE user_id = ?', id),
    topics: all('SELECT * FROM topics WHERE author = ?', id),
    replies: all('SELECT id, topic_id, body, created_at FROM replies WHERE author = ? AND deleted_at IS NULL', id),
    ingestedEvents: all('SELECT * FROM events WHERE ingested_by = ?', `user:${id}`),
  })
})

// Soft-delete: account is disabled, all sessions and tokens revoked, access graph edges removed.
r.delete('/me', (req, res) => {
  requireSession(req.principal)
  const id = req.principal.userId
  const t = now()
  tx(() => {
    run('UPDATE users SET deleted_at = ? WHERE id = ?', t, id)
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', t, id)
    run('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', t, id)
    run('DELETE FROM relationships WHERE subject = ?', `user:${id}`)
    // Erasure propagates to the lake: drop raw payloads this user ingested.
    run("UPDATE events SET payload = '(erased)' WHERE ingested_by = ?", `user:${id}`)
  })
  audit(req.principal, 'account.delete', `user:${id}`, true)
  res.status(204).end()
})

export default r
