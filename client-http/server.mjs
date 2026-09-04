// server.mjs - the browser client, and the small HTTP server behind it.
//
// Plain HTTP and JSON, no framework. The rules live in core/ and the assembly
// in host/setup.mjs; what is here is only the part that is about being a web
// page: routes, static files, and who is playing.
//
// Who is playing is the part worth reading. The page never names a game. It
// used to - it kept an id in localStorage and sent it with every request, and
// the server played whatever it was handed, which meant a browser could resume
// or delete any Telegram player's game by typing their chat id. Now the server
// keeps the name itself, in a cookie it signs, and a request says only what the
// player did.
//
//   POST /api/session               resume this player's game, or start one
//   POST /api/say      {text}       one turn: emissions, choices, summary
//   POST /api/reset                 start over, as the same player
//   POST /api/auth/telegram {user}  the Login Widget's payload, checked
//   POST /api/auth/claim   {keep}   which game to keep, when there are two
//   POST /api/auth/logout           back to playing as nobody
//   GET  /api/health
//
//   PORT              default 5090
//   MW_BIND           default 127.0.0.1 (see the note at listen)
//   MW_MODEL          local | fake | http           (default local)
//   MW_STATE_DIR      where saved games and rendered charts live
//   the rest are in .env.example

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost, createSessions, printBanner, ART, STATE_DIR } from '../host/setup.mjs'
import { createArtifacts, RENDERABLE } from '../host/deliver.mjs'
import {
  COOKIE, COOKIE_PENDING, cookieFrom, setCookie, clearCookie, signSubject, readSubject,
  newAnonSubject, telegramSubject, checkTelegramAuth,
} from '../host/auth.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Delivery: an emission becomes something the page can show
//
// The page does no drawing of its own, so a chart is rendered to a file and the
// page is handed its URL. The Telegram client writes the same file for the same
// chart, which is what lets a game played in the chat be read back here.
// ---------------------------------------------------------------------------

export function createWebDeliver (artifacts) {
  return async function deliver (id, emissions) {
    const out = []
    for (const e of emissions) {
      if (RENDERABLE.has(e.kind)) {
        const { url } = await artifacts.chart(id, e)
        out.push({ ...e, png: url })
      } else if (e.kind === 'art') {
        out.push({ ...e, url: artifacts.art(e).url })
      } else {
        out.push(e)
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

function json (res, status, body, headers = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json',
                          'Content-Length': Buffer.byteLength(data), ...headers })
  res.end(data)
}

async function readBody (req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 })
  }
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch { throw Object.assign(new Error('bad json'), { status: 400 }) }
}

async function serveFile (res, dir, name, { cache = false } = {}) {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '')
  const path = join(dir, safe)
  if (!path.startsWith(dir) || !existsSync(path)) { res.writeHead(404); return res.end('not found') }
  const data = await readFile(path)
  res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
                       'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache' })
  res.end(data)
}

/**
 * A few turns a minute per address, which is far more than a person plays and
 * far less than a script costs.
 *
 * Ordinary hygiene rather than a play limit: the game is open to anyone, but a
 * turn spends a Moth API credit, so an unattended loop should not be able to
 * spend them as fast as the network allows.
 */
export function createRateLimit ({ windowMs = 60_000, max = 40 } = {}) {
  const seen = new Map()
  return function allow (key) {
    const now = Date.now()
    // sweeping here keeps the map bounded without a timer of its own
    if (seen.size > 5000) for (const [k, v] of seen) if (now - v.start > windowMs) seen.delete(k)
    const rec = seen.get(key)
    if (!rec || now - rec.start > windowMs) { seen.set(key, { start: now, n: 1 }); return true }
    rec.n += 1
    return rec.n <= max
  }
}

/**
 * The address a request came from.
 *
 * X-Forwarded-For is only worth reading when something we control is setting
 * it. Behind Caddy that is true and the socket address is always the proxy;
 * exposed directly it is whatever the client typed, and trusting it would let
 * one script wear a new address per request.
 */
export function clientIp (req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createWebServer ({
  host,
  sessions,
  artifacts,
  secret = process.env.MW_SECRET,
  botToken = process.env.MW_LOCAL === '1'
    ? process.env.TELEGRAM_BOT_TOKEN_LOCAL
    : process.env.TELEGRAM_BOT_TOKEN,
  botUsername = process.env.MW_BOT_USERNAME || null,
  publicUrl = process.env.MW_PUBLIC_URL || '',
  trustProxy = process.env.MW_TRUST_PROXY === '1',
  botStatus = () => null,
  rateLimit = createRateLimit(),
} = {}) {
  // A fresh clone should still run: `npm run fake` is the first thing the
  // README asks anyone to do, and it must not need a secret invented first. An
  // ephemeral one costs only that saved games stop being found across a
  // restart, which on a laptop is no loss and in production is unmissable.
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    console.warn('  MW_SECRET is not set: signing cookies with a new secret each start.')
    console.warn('  Everyone is signed out by a restart. Set MW_SECRET before deploying.')
  }
  const { game, store } = host

  // Secure cookies are dropped by the browser over plain HTTP, which on a
  // localhost run would mean every request looks like a brand new player.
  const secure = /^https:/i.test(publicUrl)
  const cookieFor = (subject) => setCookie(signSubject(subject, secret), { secure })
  const loginPossible = Boolean(botToken && botUsername)

  // A display name is a nicety, not state: it is re-learned at every login and
  // nothing depends on it, so it lives here rather than in the saved game.
  const names = new Map()

  /** The subject this request proves, or null. */
  const subjectOf = (req, name = COOKIE) =>
    readSubject(cookieFrom(req.headers.cookie, name), secret)

  /** A game's standing, in the shape the page expects. */
  const standing = (subject, rec) => ({
    kind: subject.startsWith('tg') ? 'telegram' : 'anon',
    name: names.get(subject) || null,
    canLogin: loginPossible,
    botUsername,
    log: rec.log,
    logLength: rec.log.length,
    choices: game.choices(rec.session),
    summary: game.summary(rec.session),
  })

  /** Enough of a game to choose between two of them. */
  const shortSummary = (rec) => {
    const s = game.summary(rec.session)
    return { day: s.day, weekDay: s.weekDay, balance: s.balance, budget: s.budget,
             rounds: s.rounds, probation: s.probation, world: s.world?.name || null }
  }

  /**
   * A game nobody would miss: still in the opening, no round played, nothing
   * spent. Switching away from one of these needs no ceremony.
   */
  const worthKeeping = (rec) => {
    const s = game.summary(rec.session)
    return s.rounds > 0 || s.day > 1 || s.dayStep > 0
  }

  async function openFor (res, subject, { setCookieToo = true } = {}) {
    const { rec } = await sessions.open(subject)
    return json(res, 200, standing(subject, rec),
                setCookieToo ? { 'Set-Cookie': cookieFor(subject) } : {})
  }

  // -------------------------------------------------------------------------
  // Logging in
  // -------------------------------------------------------------------------

  /**
   * The Login Widget's payload, checked, and then the only interesting question
   * this file asks: which game does this person carry on with?
   *
   * They may arrive with an anonymous game in progress and already have one in
   * Telegram. Neither can be silently thrown away, so that case - and only that
   * case - asks. The pending identity is parked in its own signed cookie rather
   * than handed to the page, because the page is exactly what we have just
   * finished deciding not to trust.
   */
  async function login (req, res, body) {
    if (!loginPossible) return json(res, 501, { error: 'telegram login is not configured' })
    const user = body && typeof body === 'object' ? body.user ?? body : null
    if (!checkTelegramAuth(user, botToken)) {
      return json(res, 401, { error: 'that login did not check out' })
    }
    const tgSub = telegramSubject(user.id)
    if (user.first_name) names.set(tgSub, String(user.first_name).slice(0, 64))

    const current = subjectOf(req)
    if (current === tgSub) return openFor(res, tgSub)

    const anon = current && current.startsWith('web') ? current : null

    return sessions.enqueueAll([tgSub, ...(anon ? [anon] : [])], async () => {
      const hasTg = store.has(tgSub)
      const anonRec = anon ? await store.load(anon) : null
      const anonWorth = anonRec ? worthKeeping(anonRec) : false

      // Nothing of theirs in Telegram yet: the game they are playing becomes
      // theirs, under their name, exactly as it stands.
      if (!hasTg) {
        if (anon && anonWorth) await store.rename(anon, tgSub)
        else if (anon) await store.remove(anon)
        const { rec } = await sessions.openHeld(tgSub)
        return json(res, 200, standing(tgSub, rec), { 'Set-Cookie': cookieFor(tgSub) })
      }

      // They have a game in Telegram and nothing here worth keeping: just be
      // themselves again.
      if (!anonWorth) {
        if (anon) await store.remove(anon)
        const { rec } = await sessions.openHeld(tgSub)
        return json(res, 200, standing(tgSub, rec), { 'Set-Cookie': cookieFor(tgSub) })
      }

      // Two real games. Ask.
      const tgRec = await store.load(tgSub)
      return json(res, 200, {
        choose: { telegram: shortSummary(tgRec), anonymous: shortSummary(anonRec) },
        name: names.get(tgSub) || null,
      }, {
        'Set-Cookie': setCookie(signSubject(tgSub, secret),
                                { name: COOKIE_PENDING, secure, maxAgeSec: 900 }),
      })
    })
  }

  /** Which of the two they chose. */
  async function claim (req, res, body) {
    const tgSub = subjectOf(req, COOKIE_PENDING)
    const anon = subjectOf(req)
    if (!tgSub) return json(res, 409, { error: 'there is no login waiting to be finished' })
    const keep = body?.keep
    if (keep !== 'telegram' && keep !== 'anonymous') {
      return json(res, 400, { error: "keep must be 'telegram' or 'anonymous'" })
    }
    const drop = clearCookie(COOKIE_PENDING, { secure })

    return sessions.enqueueAll([tgSub, ...(anon ? [anon] : [])], async () => {
      if (keep === 'anonymous') {
        if (!anon || !store.has(anon)) {
          return json(res, 409, { error: 'that game is no longer here' }, { 'Set-Cookie': drop })
        }
        // Overwriting a real game is the one destructive thing a player can ask
        // for here, so the loser is kept on disk under a dated name.
        const kept = await store.backup(tgSub)
        if (kept) console.log(`  ${tgSub}: replaced game backed up to ${kept}`)
        await store.remove(tgSub)
        await store.rename(anon, tgSub)
      } else if (anon) {
        await store.remove(anon)
      }
      const { rec } = await sessions.openHeld(tgSub)
      return json(res, 200, standing(tgSub, rec),
                  { 'Set-Cookie': [cookieFor(tgSub), drop] })
    })
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, HERE, 'index.html')
        if (url.pathname === '/app.js') return serveFile(res, HERE, 'app.js')
        if (url.pathname.startsWith('/art/')) return serveFile(res, ART, url.pathname.slice(5), { cache: true })
        if (url.pathname.startsWith('/png/')) return serveFile(res, artifacts.pngDir, url.pathname.slice(5), { cache: true })
        if (url.pathname === '/api/health') {
          // Liveness and the two things that can be wrong without the process
          // dying. Not the rule dials: those are nobody else's business.
          return json(res, 200, { ok: true, model: host.model.name, bot: botStatus() })
        }
        res.writeHead(404); return res.end('not found')
      }

      if (req.method === 'POST') {
        if (!rateLimit(clientIp(req, { trustProxy }))) {
          return json(res, 429, { error: 'too many requests; wait a moment' })
        }
        const body = await readBody(req)

        if (url.pathname === '/api/auth/telegram') return login(req, res, body)
        if (url.pathname === '/api/auth/claim') return claim(req, res, body)
        if (url.pathname === '/api/auth/logout') {
          const fresh = newAnonSubject()
          const { rec } = await sessions.open(fresh)
          return json(res, 200, standing(fresh, rec), {
            'Set-Cookie': [cookieFor(fresh), clearCookie(COOKIE_PENDING, { secure })],
          })
        }

        // Everything below plays the game, and plays it as whoever the cookie
        // says. A request that names a game is not refused, it is simply not
        // listened to - there is nowhere left to put an id.
        const subject = subjectOf(req) || newAnonSubject()

        if (url.pathname === '/api/session') return openFor(res, subject)
        if (url.pathname === '/api/say') {
          // A cookie can outlive the game it names: a state directory restored
          // from a backup, or a development restart with no MW_SECRET set. The
          // page cannot do anything with a 404, so it gets a whole standing and
          // redraws from it instead.
          if (!store.has(subject)) {
            const { rec } = await sessions.open(subject)
            return json(res, 200, { ...standing(subject, rec), reopened: true },
                        { 'Set-Cookie': cookieFor(subject) })
          }
          const r = await sessions.turn(subject, String(body.text ?? ''))
          const rec = await store.load(subject)
          return json(res, 200, { ...r, logLength: rec?.log.length ?? 0 },
                      { 'Set-Cookie': cookieFor(subject) })
        }
        if (url.pathname === '/api/reset') {
          // The game goes, the player stays: a logged-in player cannot change
          // who they are by starting again, and nobody can start again for them.
          const { rec } = await sessions.reset(subject)
          return json(res, 200, standing(subject, rec), { 'Set-Cookie': cookieFor(subject) })
        }
        res.writeHead(404); return res.end('not found')
      }
      res.writeHead(405); res.end('method not allowed')
    } catch (e) {
      console.error(`  ${req.method} ${url.pathname}:`, e?.stack || e?.message || e)
      json(res, e.status || 500, { error: String(e?.message || e) })
    }
  })

  return server
}

// ---------------------------------------------------------------------------
// Boot, when this file is run on its own
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = createHost()
  const artifacts = createArtifacts({ stateDir: STATE_DIR })
  const sessions = createSessions(host, { deliver: createWebDeliver(artifacts) })
  const server = createWebServer({ host, sessions, artifacts })
  printBanner(host, 'browser')
  // Loopback by default: in production Caddy holds the certificate and is the
  // only thing that should be able to reach this.
  const PORT = Number(process.env.PORT || 5090)
  const BIND = process.env.MW_BIND || '127.0.0.1'
  server.listen(PORT, BIND, () => console.log(`  listening on http://${BIND}:${PORT}\n`))
}
