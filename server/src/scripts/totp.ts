// Dev helper: prints the current TOTP code for seeded users (stand-in for an authenticator app).
//   npm run totp            all users
//   npm run totp -- alice   one user (id or email)
import { totpCode, totpStep } from '../crypto.ts'
import { all } from '../db.ts'

const who = process.argv[2]
const users = all<{ id: string; email: string; totp_secret: string }>('SELECT id, email, totp_secret FROM users WHERE deleted_at IS NULL')
const matches = users.filter((u) => !who || u.id === who || u.email === who)
if (!matches.length) {
  console.error(`No user matching "${who}"`)
  process.exit(1)
}

const step = totpStep()
const left = 30 - (Math.floor(Date.now() / 1000) % 30)
for (const u of matches) {
  console.log(`${u.email.padEnd(20)} code ${totpCode(u.totp_secret, step)} (${left}s left, next ${totpCode(u.totp_secret, step + 1)})`)
  console.log(`${''.padEnd(20)} otpauth://totp/Dexmate:${u.email}?secret=${u.totp_secret}&issuer=Dexmate`)
}
