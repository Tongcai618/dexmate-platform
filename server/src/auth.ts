import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import type { Principal } from './authz.ts'
import { sha256 } from './crypto.ts'
import { get, run, today } from './db.ts'
import { HttpError } from './http.ts'

const secret = process.env.JWT_SECRET ?? 'dev-only-secret-change-me'
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set; using an insecure development secret.')

const SESSION_TTL = '12h'
const MFA_TTL = '5m'

type Claims = { sub: string; sid?: string; typ: 'session' | 'mfa' }

export const signSession = (userId: string, sessionId: string) =>
  jwt.sign({ sub: userId, sid: sessionId, typ: 'session' } satisfies Claims, secret, { expiresIn: SESSION_TTL })

// Short-lived proof that the password step passed; only good for the MFA step.
export const signMfa = (userId: string) => jwt.sign({ sub: userId, typ: 'mfa' } satisfies Claims, secret, { expiresIn: MFA_TTL })

export function verify(token: string, typ: Claims['typ']): Claims {
  try {
    const claims = jwt.verify(token, secret) as Claims
    if (claims.typ !== typ) throw new Error('wrong token type')
    return claims
  } catch {
    throw new HttpError(401, typ === 'mfa' ? 'Sign-in expired, start again' : 'Not signed in')
  }
}

declare global {
  namespace Express {
    interface Request {
      principal: Principal
    }
  }
}

// Accepts either a web session JWT or a `dex_` CLI token in the Authorization header.
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!bearer) throw new HttpError(401, 'Not signed in')

  if (bearer.startsWith('dex_')) {
    const tok = get<{ id: string; user_id: string; scopes: string }>(
      `SELECT t.id, t.user_id, t.scopes FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.hash = ? AND t.revoked_at IS NULL AND u.deleted_at IS NULL`, sha256(bearer))
    if (!tok) throw new HttpError(401, 'Invalid or revoked token')
    run('UPDATE tokens SET last_used = ? WHERE id = ?', today(), tok.id)
    req.principal = { userId: tok.user_id, token: { id: tok.id, scopes: JSON.parse(tok.scopes) } }
    return next()
  }

  const claims = verify(bearer, 'session')
  const session = get(
    `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND u.deleted_at IS NULL`, claims.sid!, claims.sub)
  if (!session) throw new HttpError(401, 'Session revoked')
  req.principal = { userId: claims.sub, sessionId: claims.sid }
  next()
}
