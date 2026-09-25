import { all, now, run } from './db.ts'
import { HttpError } from './http.ts'

// The single `authz.require()` facade. Web sessions and CLI tokens both resolve
// here, so a token can never do more than its owner can.
// Capabilities are derived from relationships at a scope, never from role strings.

export type Action = 'view' | 'label' | 'edit' | 'admin'
export const actions: Action[] = ['view', 'label', 'edit', 'admin']
export const relations = ['admin', 'owner', 'labeler', 'viewer', 'parent'] as const
export const allScopes = ['data:read', 'data:write', 'label:write', 'model:write', 'forum:write'] as const
export type Scope = (typeof allScopes)[number]

export const ORG = 'org:dexmate'

// Which relations grant which actions on an object.
const grants: Record<string, Action[]> = {
  admin: ['view', 'label', 'edit', 'admin'],
  owner: ['view', 'label', 'edit'],
  labeler: ['view', 'label'],
  viewer: ['view'],
}

export type Principal = {
  userId: string
  sessionId?: string
  // Present only for CLI tokens; web sessions carry every scope.
  token?: { id: string; scopes: string[] }
}

export const subjectOf = (p: Principal) => `user:${p.userId}`
const via = (p: Principal) => (p.token ? `token:${p.token.id}` : 'session')

export type CheckResult = { allowed: boolean; path: string[] }

type Rel = { subject: string; relation: string; object: string }

// Walks direct relations on `object`, then inherits through `parent` edges.
export function check(subject: string, action: Action, object: string, seen = new Set<string>()): CheckResult {
  if (seen.has(object)) return { allowed: false, path: [] }
  seen.add(object)

  for (const r of all<Rel>('SELECT * FROM relationships WHERE subject = ? AND object = ?', subject, object)) {
    if (grants[r.relation]?.includes(action)) return { allowed: true, path: [`${subject} —${r.relation}→ ${object}`] }
  }
  for (const r of all<Rel>("SELECT * FROM relationships WHERE subject = ? AND relation = 'parent'", object)) {
    const res = check(subject, action, r.object, seen)
    if (res.allowed) return { allowed: true, path: [`${object} —parent→ ${r.object}`, ...res.path] }
  }
  return { allowed: false, path: [] }
}

export function audit(p: Principal | string, action: string, object: string, allowed: boolean, detail?: unknown) {
  const actor = typeof p === 'string' ? p : subjectOf(p)
  const through = typeof p === 'string' ? 'anonymous' : via(p)
  run('INSERT INTO audit (ts, actor, via, action, object, allowed, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now(), actor, through, action, object, allowed ? 1 : 0, detail === undefined ? null : JSON.stringify(detail))
}

export function requireScope(p: Principal, scope: Scope) {
  if (p.token && !p.token.scopes.includes(scope)) throw new HttpError(403, `Token is missing scope ${scope}`)
}

// Some operations (minting tokens, editing the access graph) are never delegable to a token.
export function requireSession(p: Principal) {
  if (p.token) throw new HttpError(403, 'This action requires a signed-in web session, not an API token')
}

// Throws 403 unless allowed. Mutations are audited; reads are only audited when denied.
export function require(p: Principal, action: Action, object: string, scope: Scope) {
  requireScope(p, scope)
  const res = check(subjectOf(p), action, object)
  if (!res.allowed || action !== 'view') audit(p, action, object, res.allowed)
  if (!res.allowed) throw new HttpError(403, `You need "${action}" on ${object}`)
}

// Non-throwing variant for UI hints (e.g. whether to enable a button). Not audited.
export function can(p: Principal, action: Action, object: string, scope: Scope): boolean {
  if (p.token && !p.token.scopes.includes(scope)) return false
  return check(subjectOf(p), action, object).allowed
}

// Reverse query for lists: keep only rows whose scope the principal can `action`.
export function visible<T extends { project: string }>(p: Principal, rows: T[], action: Action = 'view'): T[] {
  const cache = new Map<string, boolean>()
  return rows.filter((r) => {
    if (!cache.has(r.project)) cache.set(r.project, check(subjectOf(p), action, r.project).allowed)
    return cache.get(r.project)
  })
}
