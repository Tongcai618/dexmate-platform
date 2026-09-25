import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message })
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON body' })
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
}

// --- Input validation ---

export function str(body: unknown, key: string, max = 200): string {
  const v = (body as Record<string, unknown> | undefined)?.[key]
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${key}" is required`)
  if (v.length > max) throw new HttpError(400, `"${key}" must be at most ${max} characters`)
  return v.trim()
}

export function oneOf<T extends string>(body: unknown, key: string, allowed: readonly T[]): T {
  const v = str(body, key)
  if (!allowed.includes(v as T)) throw new HttpError(400, `"${key}" must be one of: ${allowed.join(', ')}`)
  return v as T
}

// `type:id` object references, e.g. user:alice, project:voice
export function ref(body: unknown, key: string): string {
  const v = str(body, key, 100)
  if (!/^[a-z]+:[a-zA-Z0-9_-]+$/.test(v)) throw new HttpError(400, `"${key}" must look like type:id`)
  return v
}

// --- Rate limiting (fixed window, in-memory; swap for Redis when there's more than one instance) ---

const windows = new Map<string, { start: number; count: number }>()

export function rateLimit(key: (req: Request) => string, limit: number, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req)
    const t = Date.now()
    const w = windows.get(k)
    if (!w || t - w.start >= windowMs) windows.set(k, { start: t, count: 1 })
    else if (++w.count > limit) {
      res.setHeader('Retry-After', Math.ceil((w.start + windowMs - t) / 1000))
      return void res.status(429).json({ error: 'Too many requests' })
    }
    next()
  }
}
