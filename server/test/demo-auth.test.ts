import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

// Runs in its own process (node --test isolates files), with demo auth on as it is in `npm run dev`.
const dir = mkdtempSync(join(tmpdir(), 'dexmate-demo-test-'))
process.env.DB_PATH = join(dir, 'test.db')
process.env.JWT_SECRET = 'test-secret'
process.env.AUTH_RATE_LIMIT = '1000'
delete process.env.NODE_ENV
delete process.env.DEMO_AUTH
const { app } = await import('../src/app.ts')
const { demoAuthEnabled } = await import('../src/routes/auth.ts')

let base = ''
const server = app.listen(0)
before(() => {
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

async function signIn(email: string, password: string, code?: string) {
  const step1 = await post('/auth/login', { email, password })
  if (step1.status !== 200) return step1
  return post('/auth/mfa', code === undefined ? { mfaToken: step1.body.mfaToken } : { mfaToken: step1.body.mfaToken, code })
}

test('config reports demo mode', async () => {
  assert.deepEqual(await (await fetch(`${base}/auth/config`)).json(), { demo: true })
})

test('alice@dexmate.ai / 123456 signs in with any MFA code, or none', async () => {
  for (const code of ['000000', '999999', 'abc', '', undefined]) {
    const res = await signIn('alice@dexmate.ai', '123456', code)
    assert.equal(res.status, 200, `code ${JSON.stringify(code)}`)
    assert.equal(res.body.user.id, 'alice')
    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${res.body.token}` } })
    assert.equal(me.status, 200)
  }
})

test('the same MFA-free login works repeatedly (no replay lockout)', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await signIn('alice@dexmate.ai', '123456', '123456')).status, 200)
})

test('other passwords are still checked', async () => {
  assert.equal((await signIn('alice@dexmate.ai', 'demo', '')).status, 200, "alice's seeded password still works")
  assert.equal((await signIn('alice@dexmate.ai', 'wrong')).status, 401)
  assert.equal((await signIn('bob@dexmate.ai', '123456')).status, 401, '123456 is only for alice')
  assert.equal((await signIn('bob@dexmate.ai', 'demo', '')).status, 200, 'MFA is skipped for everyone')
})

test('the MFA step still needs a valid password-step token', async () => {
  assert.equal((await post('/auth/mfa', { mfaToken: 'garbage', code: '123456' })).status, 401)
})

test('demo auth is off in production or with DEMO_AUTH=off', () => {
  assert.equal(demoAuthEnabled({}), true)
  assert.equal(demoAuthEnabled({ NODE_ENV: 'development' }), true)
  assert.equal(demoAuthEnabled({ NODE_ENV: 'production' }), false)
  assert.equal(demoAuthEnabled({ DEMO_AUTH: 'off' }), false)
})
