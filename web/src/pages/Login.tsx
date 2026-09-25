import { useState } from 'react'
import { act, api } from '../lib/api'
import type { User } from '../lib/types'

// Custom auth UI (not hosted pages): password step, then TOTP MFA step.
export default function Login({ onLogin }: { onLogin: (user: User, token: string) => void }) {
  const [step, setStep] = useState<'password' | 'mfa'>('password')
  const [email, setEmail] = useState('alice@dexmate.ai')
  const [password, setPassword] = useState('demo')
  const [code, setCode] = useState('')
  const [mfaToken, setMfaToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    await act(setError, fn)
    setBusy(false)
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@') || !password) return setError('Enter your email and password.')
    run(async () => {
      const res = await api<{ mfaToken: string }>('/auth/login', { body: { email, password } })
      setMfaToken(res.mfaToken)
      setCode('')
      setStep('mfa')
    })
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from your authenticator app.')
    run(async () => {
      const res = await api<{ token: string; user: User }>('/auth/mfa', { body: { mfaToken, code } })
      onLogin(res.user, res.token)
    })
  }

  return (
    <div className="login-wrap">
      <div className="login card">
        <div className="brand big">dexmate<span>.platform</span></div>
        {step === 'password' ? (
          <form onSubmit={submitPassword}>
            <h2>Sign in</h2>
            <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <div className="error">{error}</div>}
            <button className="primary full" disabled={busy}>Continue</button>
            <div className="divider">or</div>
            <button type="button" className="full" disabled={busy} onClick={() => run(() => api('/auth/sso', { body: {} }))}>Continue with SSO</button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <h2>Two-factor authentication</h2>
            <p className="muted">Enter the code from your authenticator app for {email}.</p>
            <input className="otp" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            {error && <div className="error">{error}</div>}
            <button className="primary full" disabled={busy}>Verify</button>
            <button type="button" className="link" onClick={() => { setStep('password'); setError('') }}>← Back</button>
          </form>
        )}
      </div>
      <p className="muted small">Demo: alice / bob / carol @dexmate.ai, password <code>demo</code>. Get a code with <code>npm run totp -- alice</code> in <code>server/</code>.</p>
    </div>
  )
}
