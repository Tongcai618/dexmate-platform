# Dexmate platform API

Express 5 + TypeScript backend for `../web`. SQLite via Node's built-in `node:sqlite`, and TypeScript runs natively (Node ≥ 23.6), so there is no build step.

## Run

```bash
npm install
npm run dev        # API on http://localhost:4000 (restarts on file changes)
cd ../web && npm run dev   # UI on http://localhost:5173, proxies /api → :4000
```

**Demo auth is on by default:** `alice@dexmate.ai` / `123456` always signs in, and the 2FA step accepts any code (or none) for every user. `bob@dexmate.ai` and `carol@dexmate.ai` use password `demo`. The server logs a warning at startup while this is on.

Demo auth turns off with `DEMO_AUTH=off` or `NODE_ENV=production`. Passwords and TOTP codes are then checked for real, and you get codes with:

```bash
npm run totp -- alice   # current code, plus an otpauth:// URI you can add to a real authenticator app
```

Codes are single-use (replay-protected). If you sign in twice within 30s, use the "next" code it prints.

| Command | |
|---|---|
| `npm test` | 42 API tests against throwaway DBs (real auth + demo auth) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run reset` | delete `dexmate.db`; it's re-seeded on next start (stop the server first) |

Env: `PORT` (4000), `DB_PATH`, `JWT_SECRET` (dev fallback with a warning), `CORS_ORIGINS` (`http://localhost:5173`), `AUTH_RATE_LIMIT` (20/min/IP), `DEMO_AUTH` (`off` to disable demo auth). If `web/dist` exists, the server also serves the built UI.

## Seeded access graph

```
user:alice  admin   org:dexmate      ← everything, via parent edges
user:bob    owner   project:voice    ← view/label/edit voice
user:carol  labeler project:voice    ← view/label voice
user:carol  viewer  project:motion   ← view motion only
project:{voice,motion} parent org:dexmate
```

Signing in as each user shows the ReBAC differences: carol can't open Access, can see motion label items but not vote on them, and can't promote models.

## What maps to the spec

| § | Implemented | Where |
|---|---|---|
| 1 Auth | Demo auth for dev (above); otherwise password (scrypt) → short-lived MFA challenge → TOTP (RFC 6238, replay-protected) → JWT session backed by a revocable `sessions` row; logout, list/revoke sessions, GDPR export, soft-delete (revokes sessions + tokens, removes graph edges, erases ingested payloads) | `routes/auth.ts`, `auth.ts`, `crypto.ts` |
| 2 ReBAC | SpiceDB-style tuples; one `authz.require()` facade (relation grants + `parent` inheritance, path explanation); reverse-query list filtering; audit log of mutations and denials; last-admin guard | `authz.ts`, `routes/access.ts` |
| 3 Tokens | `dex_pat_…`/`dex_svc_…`, SHA-256 hashed, shown once; rotate/revoke; scopes AND relationships must both allow (no privilege bypass); tokens can't mint tokens or edit the graph; service tokens need org admin; per-token rate limit + `last_used` | `routes/tokens.ts`, `auth.ts` |
| 4/6 Data | Ingest with consent gate (dropped if no consent) + PII scrub of string fields; provenance (`ingested_by`); bronze → silver → gold promotion gated on consent + scrub | `routes/data.ts` |
| 5 Labeling | Per-project queues, one vote per labeler, `canLabel` hint, model pre-labels | `routes/data.ts` |
| 7/8 Models | Registry: register run → report eval → staging → canary → prod; gate = safety pass + ≥ prod metric + one canary per family; prod promotion archives old prod; canary rollback | `routes/models.ts` |
| 12 Forum | Topics, replies, one vote per user (no self-votes), author-only accept (emits a `forum.accepted_answer` event into the data plane, once), admin moderation | `routes/forum.ts` |
| Cross-cutting | Input validation, JSON body limit, strict CORS allow-list, security headers, rate limits, audit | `app.ts`, `http.ts` |

**Stubbed / out of scope:** WorkOS SSO/SCIM (`/auth/sso` returns 501), SpiceDB itself (`authz.ts` is the seam to swap in), outbox + consistency tokens (not needed with a single SQLite DB), Kafka/Flink/Iceberg, training/serving/edge (§7–9 are modeled as registry state only), agent plane and knowledge base (§10–11), i18n and OTel. There is no real `dex` CLI; tokens work with any HTTP client:

```bash
curl -H "Authorization: Bearer dex_pat_…" http://localhost:4000/api/events
```

## API

All routes are under `/api`. Everything except `health`, `auth/login`, `auth/mfa`, `auth/sso` and `auth/config` needs `Authorization: Bearer <session JWT | dex_ token>`.

```
GET  /health
POST /auth/login {email,password} → {mfaToken}      POST /auth/mfa {mfaToken,code} → {token,user}
GET /auth/config → {demo}   POST /auth/sso (501)   GET /auth/me   POST /auth/logout   GET /auth/sessions   DELETE /auth/sessions/:id
GET  /auth/export      DELETE /auth/me

GET/POST/DELETE /relationships      GET /check?subject&action&object → {allowed,path}      GET /audit
GET/POST /tokens {name,kind,scopes} → {token,secret}   POST /tokens/:id/rotate   DELETE /tokens/:id
GET/POST /events [?source&layer]    POST /events/:id/promote
GET /labels                         POST /labels/:id/vote {choice}
GET/POST /models {family,dataset,target}   POST /models/:id/eval {metric,safetyPass}   POST /models/:id/promote   POST /models/:id/rollback
GET/POST /topics {category,title}   GET /topics/:id   POST /topics/:id/replies {body}
POST /replies/:id/vote   POST /replies/:id/accept   DELETE /replies/:id
GET /overview
```

Errors are always `{ "error": "message" }` with a meaningful status (400 validation, 401 auth, 403 permission, 404, 409 state conflict, 429 rate limit, 501).
