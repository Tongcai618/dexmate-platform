import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { authenticate } from './auth.ts'
import { HttpError, errorHandler, rateLimit } from './http.ts'
import access from './routes/access.ts'
import auth from './routes/auth.ts'
import { events, labels } from './routes/data.ts'
import forum from './routes/forum.ts'
import models from './routes/models.ts'
import overview from './routes/overview.ts'
import tokens from './routes/tokens.ts'

// Strict CORS: only these browser origins. The Vite dev server proxies /api, so this is for split deployments.
const ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',')

export const app = express()
app.disable('x-powered-by')

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const origin = req.get('origin')
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE')
  }
  if (req.method === 'OPTIONS') return void res.status(204).end()
  next()
})
app.use(express.json({ limit: '100kb' }))

app.get('/api/health', (_req, res) => void res.json({ ok: true }))
app.use('/api/auth', auth)

// Everything below needs a session or CLI token, rate-limited per principal.
const api = express.Router()
api.use(authenticate, rateLimit((req) => req.principal.token?.id ?? req.principal.userId, 300))
api.use('/', access)
api.use('/tokens', tokens)
api.use('/events', events)
api.use('/labels', labels)
api.use('/models', models)
api.use('/', forum)
api.use('/overview', overview)
app.use('/api', api)
app.use('/api', () => {
  throw new HttpError(404, 'Not found')
})

// In production, serve the built frontend from the same origin.
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: dist }))
}

app.use(errorHandler)
