// auth.mjs - who is playing, and how the server knows.
//
// Two separate things, both HMAC, and it is worth keeping them apart:
//
//   Telegram vouches for a person.  The Login Widget hands the browser a user
//   object signed with the bot's own token. Anyone can POST that shape, so it
//   is only worth anything once the signature is checked - against a key that
//   only Telegram and this server hold, which is what makes it proof.
//
//   The server vouches for itself.  Having decided who someone is, it says so
//   in a cookie signed with MW_SECRET, so it does not have to be told again on
//   every turn. The cookie is not a secret to keep; it is a claim the server
//   refuses to believe unless it wrote it.
//
// The point of both is the same: the id of a saved game is never something a
// client gets to choose. It used to be, and a browser could resume - or delete
// - any Telegram player's game by naming it.

import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/** Anonymous browser subject. 96 bits: guessing one is not a way in. */
export const newAnonSubject = () => `web${randomBytes(12).toString('hex')}`

/** A Telegram user's subject. The USER id, never the chat id - see below. */
export const telegramSubject = (userId) => `tg${String(userId)}`

/**
 * The only shape a subject may have, checked wherever one arrives.
 *
 * Both forms are namespaced so a browser subject can never spell a Telegram
 * one, and the store keys files by exactly this string - so it also has to be
 * a safe file name.
 */
export const validSubject = (s) => typeof s === 'string' && /^(web[0-9a-f]{8,64}|tg\d{1,32})$/.test(s)

/** Constant-time compare of two hex strings of any length. */
function sameHex (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Telegram Login Widget
// ---------------------------------------------------------------------------

/**
 * The string Telegram signed: every field except `hash`, as `key=value`,
 * sorted by key, joined with newlines. Exactly as documented - the sort and the
 * omission are both load-bearing, and getting either wrong fails every login
 * with no clue as to why.
 */
export function dataCheckString (user) {
  return Object.keys(user)
    .filter((k) => k !== 'hash' && user[k] !== undefined && user[k] !== null)
    .sort()
    .map((k) => `${k}=${user[k]}`)
    .join('\n')
}

/**
 * True if this really came from Telegram, recently.
 *
 * The freshness check is not ceremony: without it a captured payload logs
 * someone in for ever, because the signature over it never expires.
 */
export function checkTelegramAuth (user, botToken, { maxAgeSec = 86400, now = Date.now } = {}) {
  if (!user || typeof user !== 'object' || typeof user.hash !== 'string') return false
  if (!botToken) throw new Error('checkTelegramAuth: no bot token to check against')
  const id = Number(user.id)
  if (!Number.isSafeInteger(id) || id <= 0) return false

  const authDate = Number(user.auth_date)
  if (!Number.isFinite(authDate)) return false
  const age = now() / 1000 - authDate
  // A little clock skew forward is normal; a lot means someone is choosing the
  // number, and the whole point of auth_date is that it cannot be chosen.
  if (age > maxAgeSec || age < -300) return false

  const secret = createHash('sha256').update(botToken).digest()
  const want = createHmac('sha256', secret).update(dataCheckString(user)).digest('hex')
  return sameHex(want, user.hash.toLowerCase())
}

// ---------------------------------------------------------------------------
// The session cookie
// ---------------------------------------------------------------------------

export const COOKIE = 'mw'
// Held only between "who are you?" and "which game do you want?", so a login
// that offers a choice does not have to be trusted to the page and sent back.
export const COOKIE_PENDING = 'mwp'
const COOKIE_VERSION = 'v1'

/** `v1.<subject>.<issued>.<signature>` - opaque to the client, and unforgeable. */
export function signSubject (subject, secret, { now = Date.now } = {}) {
  if (!validSubject(subject)) throw new Error(`signSubject: ${subject} is not a subject`)
  if (!secret) throw new Error('signSubject: MW_SECRET is not set')
  const issued = Math.floor(now() / 1000)
  const body = `${COOKIE_VERSION}.${subject}.${issued}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** The subject this cookie proves, or null if it proves nothing. */
export function readSubject (value, secret, { maxAgeSec = 400 * 86400, now = Date.now } = {}) {
  if (typeof value !== 'string' || !secret) return null
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const [version, subject, issued, sig] = parts
  if (version !== COOKIE_VERSION || !validSubject(subject)) return null
  if (!/^\d{1,15}$/.test(issued)) return null
  const body = `${version}.${subject}.${issued}`
  if (!sameHex(createHmac('sha256', secret).update(body).digest('hex'), sig)) return null
  if (now() / 1000 - Number(issued) > maxAgeSec) return null
  return subject
}

// ---------------------------------------------------------------------------
// Cookie headers
// ---------------------------------------------------------------------------

/** One named cookie out of a Cookie: header. */
export function cookieFrom (header, name = COOKIE) {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/**
 * A Set-Cookie for the session.
 *
 * HttpOnly so a script cannot read it, SameSite=Lax so another site cannot
 * spend a player's turns for them, and Secure everywhere but a plain-HTTP
 * localhost - where insisting on it would mean the cookie is set, ignored, and
 * every request looks like a new player.
 */
export function setCookie (value, { name = COOKIE, secure = true, maxAgeSec = 400 * 86400 } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** The same cookie, expired. */
export function clearCookie (name = COOKIE, { secure = true } = {}) {
  return [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
          ...(secure ? ['Secure'] : [])].join('; ')
}
