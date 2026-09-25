import { useCallback, useEffect, useState } from 'react'

// Thin client for the Express API. Vite proxies /api to the server in dev.

const KEY = 'dex_session'
let token = sessionStorage.getItem(KEY)
let onExpired = () => {}

export function setSession(t: string | null) {
  token = t
  if (t) sessionStorage.setItem(KEY, t)
  else sessionStorage.removeItem(KEY)
}

export const hasSession = () => token !== null

// Called when the server rejects our session (expired, revoked, account deleted).
export function onSessionExpired(fn: () => void) {
  onExpired = fn
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = void>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the API server. Is it running?')
  }
  const data = res.status === 204 ? null : await res.json().catch(() => undefined)
  if (!res.ok) {
    if (res.status === 401 && token) {
      setSession(null)
      onExpired()
    }
    // A non-JSON error body means the request never reached Express (e.g. the dev proxy failed).
    throw new ApiError(res.status, data?.error ?? 'Cannot reach the API server. Is it running?')
  }
  return data as T
}

// Runs a mutation, reporting any failure through `onError` (cleared first).
export async function act(onError: (msg: string) => void, fn: () => Promise<unknown>) {
  onError('')
  try {
    await fn()
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e))
  }
}

// Loads `path` on mount; `setData` lets mutations apply the server's response in place.
export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(() => {
    api<T>(path).then(
      (d) => {
        setData(d)
        setError('')
      },
      (e: Error) => setError(e.message),
    )
  }, [path])

  useEffect(reload, [reload])

  return { data, setData, error, reload }
}
