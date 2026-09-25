import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

// Fresh database per run; env must be set before the app (and db) modules load.
const dir = mkdtempSync(join(tmpdir(), 'dexmate-test-'))
process.env.DB_PATH = join(dir, 'test.db')
process.env.JWT_SECRET = 'test-secret'
process.env.AUTH_RATE_LIMIT = '1000'
delete process.env.DEMO_MFA_CODE // tests exercise real TOTP
const { app } = await import('../src/app.ts')
const { get, run } = await import('../src/db.ts')
const { totpCode, totpStep } = await import('../src/crypto.ts')

let base = ''
const server = app.listen(0)
before(() => {
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

type Res = { status: number; body: any }

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const secretOf = (id: string) => get<{ totp_secret: string }>('SELECT totp_secret FROM users WHERE id = ?', id)!.totp_secret

// Full password + TOTP login. Resets the replay guard so tests can log in repeatedly within one 30s window.
async function login(id: string): Promise<string> {
  run('UPDATE users SET totp_last_step = 0 WHERE id = ?', id)
  const step1 = await call('POST', '/auth/login', { body: { email: `${id}@dexmate.ai`, password: 'demo' } })
  assert.equal(step1.status, 200)
  const step2 = await call('POST', '/auth/mfa', { body: { mfaToken: step1.body.mfaToken, code: totpCode(secretOf(id)) } })
  assert.equal(step2.status, 200, JSON.stringify(step2.body))
  return step2.body.token
}

let alice = ''
let bob = ''
let carol = ''
before(async () => {
  ;[alice, bob, carol] = [await login('alice'), await login('bob'), await login('carol')]
})

describe('auth', () => {
  test('rejects a wrong password without revealing whether the email exists', async () => {
    const wrongPw = await call('POST', '/auth/login', { body: { email: 'alice@dexmate.ai', password: 'nope' } })
    const noUser = await call('POST', '/auth/login', { body: { email: 'ghost@dexmate.ai', password: 'nope' } })
    assert.equal(wrongPw.status, 401)
    assert.deepEqual(wrongPw.body, noUser.body)
  })

  test('requires a valid TOTP code, and each code works only once', async () => {
    run('UPDATE users SET totp_last_step = 0 WHERE id = ?', 'bob')
    const { body } = await call('POST', '/auth/login', { body: { email: 'bob@dexmate.ai', password: 'demo' } })
    const code = totpCode(secretOf('bob'))
    const wrong = code === '000000' ? '111111' : '000000'
    assert.equal((await call('POST', '/auth/mfa', { body: { mfaToken: body.mfaToken, code: wrong } })).status, 401)
    assert.equal((await call('POST', '/auth/mfa', { body: { mfaToken: body.mfaToken, code } })).status, 200)
    assert.equal((await call('POST', '/auth/mfa', { body: { mfaToken: body.mfaToken, code } })).status, 401, 'replayed code must fail')
  })

  test('the MFA challenge token is not a session', async () => {
    const { body } = await call('POST', '/auth/login', { body: { email: 'bob@dexmate.ai', password: 'demo' } })
    assert.equal((await call('GET', '/auth/me', { token: body.mfaToken })).status, 401)
  })

  test('me, sessions, and logout revokes the session', async () => {
    const token = await login('bob')
    const me = await call('GET', '/auth/me', { token })
    assert.deepEqual(me.body, { id: 'bob', name: 'Bob Park', email: 'bob@dexmate.ai' })
    const sessions = await call('GET', '/auth/sessions', { token })
    assert.equal(sessions.body.filter((s: any) => s.current).length, 1)
    assert.equal((await call('POST', '/auth/logout', { token })).status, 204)
    assert.equal((await call('GET', '/auth/me', { token })).status, 401)
  })

  test('revoking a session by id signs that session out', async () => {
    const other = await login('bob')
    const sid = JSON.parse(Buffer.from(other.split('.')[1], 'base64url').toString()).sid
    const sessions = await call('GET', '/auth/sessions', { token: bob })
    assert.ok(sessions.body.some((s: any) => s.id === sid && !s.current))
    assert.equal((await call('DELETE', `/auth/sessions/${sid}`, { token: bob })).status, 204)
    assert.equal((await call('GET', '/auth/me', { token: other })).status, 401)
    assert.equal((await call('GET', '/auth/me', { token: bob })).status, 200)
  })

  test('SSO reports that WorkOS is not configured', async () => {
    assert.equal((await call('POST', '/auth/sso', { body: {} })).status, 501)
  })

  test('unauthenticated API calls are rejected', async () => {
    assert.equal((await call('GET', '/events')).status, 401)
    assert.equal((await call('GET', '/events', { token: 'garbage' })).status, 401)
  })
})

describe('ReBAC', () => {
  test('check explains the path, including inheritance through parent edges', async () => {
    const direct = await call('GET', '/check?subject=user:carol&action=label&object=project:voice', { token: alice })
    assert.deepEqual(direct.body, { allowed: true, path: ['user:carol —labeler→ project:voice'] })

    const inherited = await call('GET', '/check?subject=user:alice&action=edit&object=project:motion', { token: alice })
    assert.deepEqual(inherited.body, { allowed: true, path: ['project:motion —parent→ org:dexmate', 'user:alice —admin→ org:dexmate'] })

    const denied = await call('GET', '/check?subject=user:carol&action=edit&object=project:voice', { token: alice })
    assert.deepEqual(denied.body, { allowed: false, path: [] })
  })

  test('only org admins can change the graph; only org viewers can read it', async () => {
    assert.equal((await call('GET', '/relationships', { token: bob })).status, 403)
    const tuple = { subject: 'user:bob', relation: 'viewer', object: 'project:motion' }
    assert.equal((await call('POST', '/relationships', { token: bob, body: tuple })).status, 403)

    assert.equal((await call('POST', '/relationships', { token: alice, body: tuple })).status, 201)
    assert.equal((await call('POST', '/relationships', { token: alice, body: tuple })).status, 409)
    assert.equal((await call('GET', '/check?subject=user:bob&action=view&object=project:motion', { token: alice })).body.allowed, true)

    assert.equal((await call('DELETE', '/relationships', { token: alice, body: tuple })).status, 204)
    assert.equal((await call('DELETE', '/relationships', { token: alice, body: tuple })).status, 404)
    assert.equal((await call('GET', '/check?subject=user:bob&action=view&object=project:motion', { token: alice })).body.allowed, false)
  })

  test('validates tuples and refuses to remove the last org admin', async () => {
    assert.equal((await call('POST', '/relationships', { token: alice, body: { subject: 'bob', relation: 'viewer', object: 'project:motion' } })).status, 400)
    assert.equal((await call('POST', '/relationships', { token: alice, body: { subject: 'user:bob', relation: 'superuser', object: 'project:motion' } })).status, 400)
    const res = await call('DELETE', '/relationships', { token: alice, body: { subject: 'user:alice', relation: 'admin', object: 'org:dexmate' } })
    assert.equal(res.status, 409)
  })

  test('denied checks and graph writes land in the audit log', async () => {
    const log = await call('GET', '/audit', { token: alice })
    assert.equal(log.status, 200)
    assert.ok(log.body.some((a: any) => a.action === 'rel.write' && a.allowed === 1))
    assert.ok(log.body.some((a: any) => a.actor === 'user:bob' && a.allowed === 0))
    assert.equal((await call('GET', '/audit', { token: bob })).status, 403)
  })
})

describe('data collection', () => {
  test('lists are filtered to what the caller can view (reverse query)', async () => {
    const ids = async (token: string) => (await call('GET', '/events', { token })).body.map((e: any) => e.id).sort()
    assert.deepEqual(await ids(alice), ['ev_101', 'ev_102', 'ev_103', 'ev_104', 'ev_105'])
    assert.deepEqual(await ids(bob), ['ev_102', 'ev_104'])
    assert.deepEqual(await ids(carol), ['ev_101', 'ev_102', 'ev_104'])
  })

  test('filters by source and layer, and validates them', async () => {
    const res = await call('GET', '/events?source=robot&layer=silver', { token: alice })
    assert.deepEqual(res.body.map((e: any) => e.id), ['ev_101'])
    assert.equal((await call('GET', '/events?source=satellite', { token: alice })).status, 400)
  })

  test('ingest scrubs PII from strings but leaves numbers alone', async () => {
    const res = await call('POST', '/events', {
      token: bob,
      body: { source: 'app', type: 'voice.command', project: 'project:voice', consent: true, payload: { text: 'email me at jo@x.com or call 555-123-4567', ts: 1727270531, when: '2026-09-25 13:02:11' } },
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.layer, 'bronze')
    assert.equal(res.body.piiScrubbed, true)
    assert.deepEqual(JSON.parse(res.body.payload), { text: 'email me at [REDACTED] or call [REDACTED]', ts: 1727270531, when: '2026-09-25 13:02:11' })
  })

  test('events without consent are dropped at ingest and cannot be promoted', async () => {
    const res = await call('POST', '/events', { token: bob, body: { source: 'app', type: 'voice.command', project: 'project:voice', consent: false, payload: { text: 'secret' } } })
    assert.equal(res.body.payload, '(dropped: no consent)')
    assert.equal((await call('POST', `/events/${res.body.id}/promote`, { token: bob })).status, 409)
  })

  test('promotion walks bronze → silver → gold', async () => {
    const { body } = await call('POST', '/events', { token: bob, body: { source: 'app', type: 'x', project: 'project:voice', consent: true, payload: {} } })
    assert.equal((await call('POST', `/events/${body.id}/promote`, { token: bob })).body.layer, 'silver')
    assert.equal((await call('POST', `/events/${body.id}/promote`, { token: bob })).body.layer, 'gold')
    assert.equal((await call('POST', `/events/${body.id}/promote`, { token: bob })).status, 409)
  })

  test('ingest needs edit on the project', async () => {
    const res = await call('POST', '/events', { token: carol, body: { source: 'app', type: 'x', project: 'project:voice', consent: true, payload: {} } })
    assert.equal(res.status, 403)
  })
})

describe('labeling', () => {
  test('queue is scoped and says which items the caller can label', async () => {
    const items = (await call('GET', '/labels', { token: carol })).body
    assert.deepEqual(items.map((i: any) => [i.id, i.canLabel]), [['li_1', true], ['li_2', true], ['li_3', false], ['li_4', false]])
    assert.deepEqual((await call('GET', '/labels', { token: bob })).body.map((i: any) => i.id), ['li_1', 'li_2'])
  })

  test('votes are stored per user, validated, and permission-checked', async () => {
    const res = await call('POST', '/labels/li_2/vote', { token: carol, body: { choice: 'question' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.votes, { bob: 'question', carol: 'question' })

    const changed = await call('POST', '/labels/li_2/vote', { token: carol, body: { choice: 'feedback' } })
    assert.equal(changed.body.votes.carol, 'feedback')

    assert.equal((await call('POST', '/labels/li_2/vote', { token: carol, body: { choice: 'not-an-option' } })).status, 400)
    assert.equal((await call('POST', '/labels/li_3/vote', { token: carol, body: { choice: 'empty' } })).status, 403)
    assert.equal((await call('POST', '/labels/nope/vote', { token: carol, body: { choice: 'x' } })).status, 404)
  })
})

describe('models', () => {
  const byId = (list: any[], id: string) => list.find((m) => m.id === id)

  test('list carries the promotion gate and edit permission', async () => {
    const list = (await call('GET', '/models', { token: carol })).body
    assert.equal(byId(list, 'm_4').blocked, 'Failed safety eval')
    assert.equal(byId(list, 'm_2').blocked, null)
    assert.equal(byId(list, 'm_2').canEdit, false)
    assert.equal(byId(list, 'm_5'), undefined, 'llm models live at org scope; carol cannot see them')
  })

  test('gate and permissions are enforced server-side', async () => {
    assert.equal((await call('POST', '/models/m_4/promote', { token: alice })).status, 409)
    assert.equal((await call('POST', '/models/m_6/promote', { token: alice })).status, 409)
    assert.equal((await call('POST', '/models/m_2/promote', { token: carol })).status, 403)
    assert.equal((await call('POST', '/models/m_1/rollback', { token: bob })).status, 409)
  })

  test('promoting canary → prod archives the previous prod model', async () => {
    const res = await call('POST', '/models/m_2/promote', { token: bob })
    assert.equal(res.status, 200)
    assert.equal(byId(res.body, 'm_2').stage, 'prod')
    assert.equal(byId(res.body, 'm_1').stage, 'archived')
  })

  test('training run → eval → staging → canary, with a single canary per family', async () => {
    let list = (await call('POST', '/models', { token: alice, body: { family: 'motion', dataset: 'grasp-traj@v7', target: 'edge' } })).body
    const run1 = list.find((m: any) => m.dataset === 'grasp-traj@v7')
    assert.deepEqual([run1.version, run1.stage], [5, 'training'])

    assert.equal((await call('POST', `/models/${run1.id}/eval`, { token: alice, body: { metric: 2, safetyPass: true } })).status, 400)
    list = (await call('POST', `/models/${run1.id}/eval`, { token: alice, body: { metric: 0.9, safetyPass: true } })).body
    assert.equal(byId(list, run1.id).stage, 'staging')

    list = (await call('POST', `/models/${run1.id}/promote`, { token: alice })).body
    assert.equal(byId(list, run1.id).stage, 'canary')

    list = (await call('POST', '/models', { token: alice, body: { family: 'motion', dataset: 'grasp-traj@v8', target: 'edge' } })).body
    const run2 = list.find((m: any) => m.dataset === 'grasp-traj@v8')
    list = (await call('POST', `/models/${run2.id}/eval`, { token: alice, body: { metric: 0.95, safetyPass: true } })).body
    assert.equal(byId(list, run2.id).blocked, 'Another canary is running')

    list = (await call('POST', `/models/${run1.id}/rollback`, { token: alice })).body
    assert.equal(byId(list, run1.id).stage, 'archived')
    assert.equal(byId(list, run2.id).blocked, null)
  })
})

describe('CLI tokens', () => {
  test('secret is returned once and only its hash is stored', async () => {
    const res = await call('POST', '/tokens', { token: carol, body: { name: 'laptop', kind: 'personal', scopes: ['data:read'] } })
    assert.equal(res.status, 201)
    assert.match(res.body.secret, /^dex_pat_/)
    const row = get<{ hash: string }>('SELECT hash FROM tokens WHERE id = ?', res.body.token.id)!
    assert.notEqual(row.hash, res.body.secret)
    const list = (await call('GET', '/tokens', { token: carol })).body
    assert.ok(list.every((t: any) => !('secret' in t) && !('hash' in t)))
  })

  test('tokens resolve through the same facade: scopes AND relationships must allow', async () => {
    const { body } = await call('POST', '/tokens', { token: carol, body: { name: 'labeler', kind: 'personal', scopes: ['data:read', 'label:write'] } })
    const tok = body.secret
    assert.deepEqual((await call('GET', '/events', { token: tok })).body.map((e: any) => e.id).sort(), (await call('GET', '/events', { token: carol })).body.map((e: any) => e.id).sort())
    assert.equal((await call('POST', '/labels/li_1/vote', { token: tok, body: { choice: 'pick' } })).status, 200)
    assert.equal((await call('POST', '/labels/li_3/vote', { token: tok, body: { choice: 'empty' } })).status, 403, 'scope does not bypass ReBAC')
    assert.equal((await call('POST', '/topics/t_1/replies', { token: tok, body: { body: 'hi' } })).status, 403, 'missing forum:write')
    const lastUsed = get<{ last_used: string }>('SELECT last_used FROM tokens WHERE id = ?', body.token.id)!.last_used
    assert.ok(lastUsed)
  })

  test('tokens cannot mint tokens or edit the access graph', async () => {
    const { body } = await call('POST', '/tokens', { token: alice, body: { name: 'admin-cli', kind: 'personal', scopes: ['data:read', 'data:write'] } })
    assert.equal((await call('GET', '/tokens', { token: body.secret })).status, 403)
    assert.equal((await call('POST', '/relationships', { token: body.secret, body: { subject: 'user:bob', relation: 'admin', object: 'org:dexmate' } })).status, 403)
    assert.equal((await call('GET', '/relationships', { token: body.secret })).status, 200, 'reads are fine with data:read')
  })

  test('service tokens need org admin; scopes are validated', async () => {
    assert.equal((await call('POST', '/tokens', { token: bob, body: { name: 'ci', kind: 'service', scopes: ['data:read'] } })).status, 403)
    assert.equal((await call('POST', '/tokens', { token: alice, body: { name: 'ci', kind: 'service', scopes: ['data:read'] } })).status, 201)
    assert.equal((await call('POST', '/tokens', { token: alice, body: { name: 'x', kind: 'personal', scopes: ['root'] } })).status, 400)
    assert.equal((await call('POST', '/tokens', { token: alice, body: { name: 'x', kind: 'personal', scopes: [] } })).status, 400)
  })

  test('revoke and rotate', async () => {
    const { body } = await call('POST', '/tokens', { token: bob, body: { name: 'r', kind: 'personal', scopes: ['data:read'] } })
    const rotated = await call('POST', `/tokens/${body.token.id}/rotate`, { token: bob })
    assert.equal(rotated.status, 201)
    assert.equal((await call('GET', '/events', { token: body.secret })).status, 401, 'old secret dies on rotate')
    assert.equal((await call('GET', '/events', { token: rotated.body.secret })).status, 200)

    const revoked = await call('DELETE', `/tokens/${rotated.body.token.id}`, { token: bob })
    assert.equal(revoked.body.revoked, true)
    assert.equal((await call('GET', '/events', { token: rotated.body.secret })).status, 401)
    assert.equal((await call('DELETE', `/tokens/${rotated.body.token.id}`, { token: bob })).status, 409)
    assert.equal((await call('DELETE', '/tokens/tok_1', { token: bob })).status, 404, "can't touch someone else's token")
  })
})

describe('forum', () => {
  test('reply, vote once, and only the author accepts', async () => {
    let topic = (await call('POST', '/topics/t_1/replies', { token: alice, body: { body: 'Try the new firmware.' } })).body
    const reply = topic.replies.at(-1)
    assert.deepEqual([reply.author, reply.votes], ['alice', 0])

    topic = (await call('POST', `/replies/${reply.id}/vote`, { token: bob })).body
    topic = (await call('POST', `/replies/${reply.id}/vote`, { token: bob })).body
    assert.equal(topic.replies.at(-1).votes, 1)
    assert.equal(topic.replies.at(-1).voted, true)

    assert.equal((await call('POST', `/replies/${reply.id}/accept`, { token: bob })).status, 403)

    const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'forum.accepted_answer'")!.n
    topic = (await call('POST', `/replies/${reply.id}/accept`, { token: carol })).body
    assert.deepEqual(topic.replies.map((r: any) => r.accepted), [false, true])
    await call('POST', `/replies/${reply.id}/accept`, { token: carol })
    const afterCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'forum.accepted_answer'")!.n
    assert.equal(afterCount, before + 1, 'accepted answer feeds the data plane exactly once')
  })

  test('topics can be created; empty replies are rejected; admins moderate', async () => {
    const t = (await call('POST', '/topics', { token: bob, body: { category: 'Motion', title: 'Arm jitters at rest' } })).body
    assert.equal(t.author, 'bob')
    assert.equal((await call('POST', `/topics/${t.id}/replies`, { token: bob, body: { body: '   ' } })).status, 400)
    const withReply = (await call('POST', `/topics/${t.id}/replies`, { token: carol, body: { body: 'spam' } })).body
    const id = withReply.replies[0].id
    assert.equal((await call('DELETE', `/replies/${id}`, { token: bob })).status, 403)
    assert.deepEqual((await call('DELETE', `/replies/${id}`, { token: alice })).body.replies, [])
  })
})

describe('overview', () => {
  test('counts are scoped to the caller', async () => {
    const res = await call('GET', '/overview', { token: bob })
    assert.equal(res.status, 200)
    assert.equal(res.body.inProd, 1)
    assert.equal(typeof res.body.events, 'number')
  })
})

describe('account lifecycle', () => {
  test('GDPR export contains the user’s own data', async () => {
    const res = await call('GET', '/auth/export', { token: carol })
    assert.equal(res.body.user.id, 'carol')
    assert.ok(res.body.relationships.length >= 2)
    assert.ok(res.body.labelVotes.some((v: any) => v.item_id === 'li_2'))
  })

  test('soft delete revokes sessions, tokens, and access', async () => {
    const { body } = await call('POST', '/tokens', { token: carol, body: { name: 'bye', kind: 'personal', scopes: ['data:read'] } })
    assert.equal((await call('DELETE', '/auth/me', { token: carol })).status, 204)
    assert.equal((await call('GET', '/auth/me', { token: carol })).status, 401)
    assert.equal((await call('GET', '/events', { token: body.secret })).status, 401)
    assert.equal((await call('POST', '/auth/login', { body: { email: 'carol@dexmate.ai', password: 'demo' } })).status, 401)
    assert.equal((await call('GET', '/check?subject=user:carol&action=view&object=project:voice', { token: alice })).body.allowed, false)
  })
})

describe('hardening', () => {
  test('bad JSON is a 400, unknown routes are 404, and security headers are set', async () => {
    const res = await fetch(`${base}/labels/li_1/vote`, { method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' }, body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await call('GET', '/nope', { token: alice })).status, 404)
  })

  test('CORS only reflects allowed origins', async () => {
    const ok = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:5173' } })
    const evil = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } })
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.equal(evil.headers.get('access-control-allow-origin'), null)
  })

  test('TOTP matches the RFC 6238 test vector', () => {
    // RFC 6238 SHA-1 secret "12345678901234567890" in base32, T = 59s → 94287082 (last 6 digits: 287082)
    assert.equal(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', totpStep(59_000)), '287082')
  })
})
