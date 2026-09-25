import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Passwords: scrypt with a per-user salt, stored as `salt:hash` (hex).
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 32)
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'))
}

// API tokens are only ever stored as a SHA-256 hash.
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const randomId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`

// --- TOTP (RFC 6238: HMAC-SHA1, 30s step, 6 digits) ---

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function newTotpSecret(): string {
  let bits = ''
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

function base32Decode(s: string): Buffer {
  let bits = ''
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0')
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / 30)

export function totpCode(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 0xf
  const bin = mac.readUInt32BE(offset) & 0x7fffffff
  return (bin % 1_000_000).toString().padStart(6, '0')
}

// Accepts the current step ±1 for clock skew. Returns the matched step so the
// caller can reject replays of an already-used code.
export function verifyTotp(secret: string, code: string): number | null {
  const now = totpStep()
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code.padEnd(6).slice(0, 6)))) return step
  }
  return null
}
