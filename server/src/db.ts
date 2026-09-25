import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { hashPassword, newTotpSecret, randomId, sha256 } from './crypto.ts'

const file = process.env.DB_PATH ?? fileURLToPath(new URL('../dexmate.db', import.meta.url))
export const db = new DatabaseSync(file)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, totp_last_step INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, revoked_at TEXT
);
-- ReBAC tuples: subject has relation on object (e.g. user:alice admin org:dexmate)
CREATE TABLE IF NOT EXISTS relationships (
  subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
  PRIMARY KEY (subject, relation, object)
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'service')), scopes TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, project TEXT NOT NULL,
  consent INTEGER NOT NULL, pii_scrubbed INTEGER NOT NULL, layer TEXT NOT NULL, payload TEXT NOT NULL,
  ingested_by TEXT
);
CREATE TABLE IF NOT EXISTS label_items (
  id TEXT PRIMARY KEY, modality TEXT NOT NULL, project TEXT NOT NULL, content TEXT NOT NULL,
  options TEXT NOT NULL, prelabel TEXT
);
CREATE TABLE IF NOT EXISTS label_votes (
  item_id TEXT NOT NULL REFERENCES label_items(id), user_id TEXT NOT NULL, choice TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, family TEXT NOT NULL, project TEXT NOT NULL, version INTEGER NOT NULL,
  stage TEXT NOT NULL, dataset TEXT NOT NULL, metric REAL NOT NULL, safety_pass INTEGER NOT NULL, target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), author TEXT NOT NULL, body TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS reply_votes (
  reply_id TEXT NOT NULL REFERENCES replies(id), user_id TEXT NOT NULL, PRIMARY KEY (reply_id, user_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL,
  action TEXT NOT NULL, object TEXT NOT NULL, allowed INTEGER NOT NULL, detail TEXT
);
`)

// Small typed helpers over node:sqlite.
export const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[]
export const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as T | undefined
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const now = () => new Date().toISOString()
export const today = () => now().slice(0, 10)

// --- Seed (mirrors the frontend's former mock data) ---

function seed() {
  const users = [
    { id: 'alice', name: 'Alice Chen', email: 'alice@dexmate.ai' },
    { id: 'bob', name: 'Bob Park', email: 'bob@dexmate.ai' },
    { id: 'carol', name: 'Carol Diaz', email: 'carol@dexmate.ai' },
  ]
  for (const u of users) {
    run('INSERT INTO users (id, name, email, password_hash, totp_secret) VALUES (?, ?, ?, ?, ?)', u.id, u.name, u.email, hashPassword('demo'), newTotpSecret())
  }

  const rels = [
    ['user:alice', 'admin', 'org:dexmate'],
    ['user:bob', 'owner', 'project:voice'],
    ['user:carol', 'labeler', 'project:voice'],
    ['user:carol', 'viewer', 'project:motion'],
    ['project:voice', 'parent', 'org:dexmate'],
    ['project:motion', 'parent', 'org:dexmate'],
  ]
  for (const r of rels) run('INSERT INTO relationships VALUES (?, ?, ?)', ...r)

  // Seeded tokens have random secrets nobody knows; create a new one in the UI to try the CLI path.
  const tokens: [string, string, string, string[], string, string | null, boolean][] = [
    ['tok_1', 'laptop-cli', 'personal', ['data:read', 'label:write'], '2026-09-01', '2026-09-24', false],
    ['tok_2', 'ci-trainer', 'service', ['data:read', 'model:write'], '2026-08-12', '2026-09-25', false],
    ['tok_3', 'old-script', 'personal', ['data:read'], '2026-05-03', '2026-06-10', true],
  ]
  for (const [id, name, kind, scopes, created, used, revoked] of tokens) {
    run('INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, 'alice', name, kind, JSON.stringify(scopes), sha256(randomId('seed')), created, used, revoked ? created : null)
  }

  const events: [string, string, string, string, string, number, number, string, string][] = [
    ['ev_101', '2026-09-25 13:02:11', 'robot', 'telemetry.joint_state', 'project:motion', 1, 1, 'silver', '{"joint":"elbow_l","torque":3.2}'],
    ['ev_102', '2026-09-25 13:02:14', 'app', 'voice.command', 'project:voice', 1, 1, 'bronze', '{"text":"pick up the [REDACTED] cup"}'],
    ['ev_103', '2026-09-25 13:03:40', 'agent', 'agent.trace', 'org:dexmate', 1, 1, 'gold', '{"tool":"kb.search","latency_ms":84}'],
    ['ev_104', '2026-09-25 13:04:02', 'app', 'voice.command', 'project:voice', 0, 0, 'bronze', '(dropped: no consent)'],
    ['ev_105', '2026-09-25 13:05:19', 'forum', 'forum.accepted_answer', 'org:dexmate', 1, 1, 'silver', '{"topic":"t_2","reply":"r_5"}'],
  ]
  for (const e of events) run('INSERT INTO events (id, ts, source, type, project, consent, pii_scrubbed, layer, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...e)

  const items: [string, string, string, string, string[], string | null, Record<string, string>][] = [
    ['li_1', 'voice', 'project:voice', '"hey dex, grab the red mug"', ['pick', 'place', 'navigate', 'other'], 'pick', { bob: 'pick', carol: 'pick' }],
    ['li_2', 'nlp', 'project:voice', '"the arm stopped halfway, is that normal?"', ['bug report', 'question', 'feedback'], 'bug report', { bob: 'question' }],
    ['li_3', 'vision', 'project:motion', 'frame_08812.jpg — tabletop, 3 objects', ['graspable', 'occluded', 'empty'], 'graspable', {}],
    ['li_4', 'motion', 'project:motion', 'trajectory #4471 — reach & grasp', ['success', 'collision', 'timeout'], 'success', { bob: 'success', carol: 'collision' }],
  ]
  for (const [id, modality, project, content, options, prelabel, votes] of items) {
    run('INSERT INTO label_items VALUES (?, ?, ?, ?, ?, ?)', id, modality, project, content, JSON.stringify(options), prelabel)
    for (const [who, choice] of Object.entries(votes)) run('INSERT INTO label_votes VALUES (?, ?, ?)', id, who, choice)
  }

  const models: [string, string, string, number, string, string, number, number, string][] = [
    ['m_1', 'voice', 'project:voice', 7, 'prod', 'voice-cmds@v12', 0.931, 1, 'edge'],
    ['m_2', 'voice', 'project:voice', 8, 'canary', 'voice-cmds@v13', 0.944, 1, 'edge'],
    ['m_3', 'motion', 'project:motion', 3, 'prod', 'grasp-traj@v5', 0.872, 1, 'edge'],
    ['m_4', 'motion', 'project:motion', 4, 'staging', 'grasp-traj@v6', 0.861, 0, 'edge'],
    ['m_5', 'llm', 'org:dexmate', 2, 'prod', 'support-qa@v3', 0.812, 1, 'cloud'],
    ['m_6', 'llm', 'org:dexmate', 3, 'training', 'support-qa@v4', 0, 0, 'cloud'],
  ]
  for (const m of models) run('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...m)

  run('INSERT INTO topics VALUES (?, ?, ?, ?, ?)', 't_1', 'Hardware', 'Gripper calibration drifts after OTA', 'carol', '2026-09-20T10:00:00Z')
  run('INSERT INTO topics VALUES (?, ?, ?, ?, ?)', 't_2', 'Voice', 'Wake word misses in noisy kitchens', 'bob', '2026-09-21T10:00:00Z')
  const replies: [string, string, string, string, number, number][] = [
    ['r_1', 't_1', 'bob', 'Re-run `dex robot calibrate --gripper` after each update.', 0, 3],
    ['r_4', 't_2', 'alice', 'Voice v8 (canary) was trained on the new kitchen-noise set.', 0, 2],
    ['r_5', 't_2', 'carol', 'Setting mic gain to 0.7 fixed it for us.', 1, 9],
  ]
  for (const [id, topic, author, body, accepted, votes] of replies) {
    run('INSERT INTO replies (id, topic_id, author, body, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, topic, author, body, accepted, '2026-09-22T10:00:00Z')
    // Historical votes from community members outside this demo org.
    for (let i = 0; i < votes; i++) run('INSERT INTO reply_votes VALUES (?, ?)', id, `community_${i}`)
  }
}

if (!get('SELECT 1 FROM users LIMIT 1')) {
  tx(seed)
  console.log('Seeded database. Login with any seeded user, password "demo"; get a TOTP code with `npm run totp -- <user>`.')
}
