import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as authz from '../authz.ts'
import { ORG, allScopes } from '../authz.ts'
import { randomId, sha256 } from '../crypto.ts'
import { all, get, run, today, tx } from '../db.ts'
import { HttpError, oneOf, str } from '../http.ts'

type TokenRow = { id: string; user_id: string; name: string; kind: 'personal' | 'service'; scopes: string; created_at: string; last_used: string | null; revoked_at: string | null }

const toApi = (t: TokenRow) => ({
  id: t.id, name: t.name, kind: t.kind, scopes: JSON.parse(t.scopes) as string[],
  createdAt: t.created_at, lastUsed: t.last_used, revoked: t.revoked_at !== null,
})

const r = Router()

// Tokens can't manage tokens: minting is a web-session-only action.
r.use((req, _res, next) => {
  authz.requireSession(req.principal)
  next()
})

r.get('/', (req, res) => {
  res.json(all<TokenRow>('SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC', req.principal.userId).map(toApi))
})

function mint(userId: string, name: string, kind: TokenRow['kind'], scopes: string[]) {
  const secret = `dex_${kind === 'personal' ? 'pat' : 'svc'}_${randomBytes(24).toString('base64url')}`
  const id = randomId('tok')
  run('INSERT INTO tokens (id, user_id, name, kind, scopes, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, userId, name, kind, JSON.stringify(scopes), sha256(secret), today())
  return { id, secret }
}

function ownToken(userId: string, id: string) {
  const t = get<TokenRow>('SELECT * FROM tokens WHERE id = ? AND user_id = ?', id, userId)
  if (!t) throw new HttpError(404, 'Token not found')
  if (t.revoked_at) throw new HttpError(409, 'Token is already revoked')
  return t
}

r.post('/', (req, res) => {
  const name = str(req.body, 'name', 64)
  const kind = oneOf(req.body, 'kind', ['personal', 'service'] as const)
  const scopes: unknown = req.body?.scopes
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => allScopes.includes(s))) {
    throw new HttpError(400, `"scopes" must be a non-empty list from: ${allScopes.join(', ')}`)
  }
  // Service tokens outlive any one person, so only org admins can create them.
  if (kind === 'service') authz.require(req.principal, 'admin', ORG, 'data:read')

  const { id, secret } = mint(req.principal.userId, name, kind, [...new Set(scopes as string[])])
  authz.audit(req.principal, 'token.create', `token:${id}`, true, { kind, scopes })
  res.status(201).json({ token: toApi(get<TokenRow>('SELECT * FROM tokens WHERE id = ?', id)!), secret })
})

r.post('/:id/rotate', (req, res) => {
  const old = ownToken(req.principal.userId, req.params.id)
  const { id, secret } = tx(() => {
    run('UPDATE tokens SET revoked_at = ? WHERE id = ?', today(), old.id)
    return mint(old.user_id, old.name, old.kind, JSON.parse(old.scopes))
  })
  authz.audit(req.principal, 'token.rotate', `token:${old.id}`, true, { replacedBy: id })
  res.status(201).json({ token: toApi(get<TokenRow>('SELECT * FROM tokens WHERE id = ?', id)!), secret })
})

r.delete('/:id', (req, res) => {
  const t = ownToken(req.principal.userId, req.params.id)
  run('UPDATE tokens SET revoked_at = ? WHERE id = ?', today(), t.id)
  authz.audit(req.principal, 'token.revoke', `token:${t.id}`, true)
  res.json(toApi(get<TokenRow>('SELECT * FROM tokens WHERE id = ?', t.id)!))
})

export default r
