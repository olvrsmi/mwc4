// web.mjs - who the HTTP client thinks you are.
//
//   node test/web.mjs
//
// A real server on a real socket, driven with fetch and a cookie jar, against
// the fake physics and a scratch directory. What is checked is identity: that a
// request cannot name someone else's game, that logging in with Telegram finds
// the right one, and that when a player has two games neither is thrown away
// without being asked.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import { loadSpecs } from '../host/specs.mjs'
import { createStore } from '../host/store.mjs'
import { createSessions } from '../host/setup.mjs'
import { createArtifacts } from '../host/deliver.mjs'
import { createWebServer, createWebDeliver, createRateLimit, clientIp } from '../client-http/server.mjs'
import { createBot } from '../client-telegram/bot.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COPY = parseYaml(readFileSync(join(ROOT, 'core', 'copy.yaml'), 'utf8'))
const specs = loadSpecs({ steps: 10 })

let failures = 0
let passes = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passes += 1; return console.log(`  pass  ${name}`) }
  failures += 1
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
const section = (name) => console.log(`\n  -- ${name}`)

const SECRET = 'test-secret'
const TOKEN = '424242:TEST-TOKEN'
const quiet = { log () {}, error () {} }

/** A server on an ephemeral port, over a scratch store. */
async function harness ({ rateLimit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mw4-web-'))
  const copy = createCopy(COPY, { random: () => 0 })
  const model = createFakeModel({ worlds: specs.worlds })
  const game = createGame({ copy, model })
  const store = createStore(dir)
  const host = { rules: game.rules, loaded: specs, copy, model, game, store }
  const artifacts = createArtifacts({ stateDir: dir, log: quiet })
  const queues = new Map()
  const sessions = createSessions(host, { deliver: createWebDeliver(artifacts), queues })
  const server = createWebServer({
    host, sessions, artifacts, secret: SECRET, botToken: TOKEN,
    botUsername: 'mw_test_bot', publicUrl: 'http://localhost', rateLimit,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base, store, dir, game, artifacts, host, queues, sessions,
    cleanup: async () => {
      await new Promise((r) => server.close(r))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** One browser: it holds cookies and knows nothing else. */
function browser (base) {
  const jar = new Map()
  return {
    jar,
    async post (path, body = {}) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
        body: JSON.stringify(body),
      })
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq).trim()
        if (/max-age=0/i.test(line)) jar.delete(name)
        else jar.set(name, pair.slice(eq + 1).trim())
      }
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
  }
}

/** The Login Widget's payload, signed the way Telegram would sign it. */
function login (id, first_name = 'Ada', { token = TOKEN, skew = 0 } = {}) {
  const fields = { id, first_name, auth_date: Math.floor(Date.now() / 1000) - skew }
  const pairs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secretKey = createHash('sha256').update(token).digest()
  return { ...fields, hash: createHmac('sha256', secretKey).update(pairs).digest('hex') }
}

/** Play far enough in that the game is plainly someone's week. */
async function playOn (b) {
  await b.post('/api/session')
  // the opening asks their name before it will be skipped past
  for (const t of ['OJS', 'skip', '1', 'o', 'i', '100', '0', '5']) await b.post('/api/say', { text: t })
  return (await b.post('/api/session')).body
}

const idsIn = (dir) => readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))

// ---------------------------------------------------------------------------
section('a guest')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  const a = browser(h.base)
  const first = await a.post('/api/session')
  ok('a visitor is given a game', first.status === 200 && first.body.log.length > 0)
  ok('and it is a guest game', first.body.kind === 'anon')
  ok('the server names it, not the page', first.body.id === undefined)
  ok('a cookie carries who they are', a.jar.has('mw'))
  ok('the login is offered', first.body.canLogin === true && first.body.botUsername === 'mw_test_bot')

  await a.post('/api/say', { text: 'skip' })
  const again = await a.post('/api/session')
  ok('coming back finds the same game', again.body.logLength > first.body.logLength)

  const b = browser(h.base)
  await b.post('/api/session')
  ok('another browser is another player', idsIn(h.dir).length === 2, idsIn(h.dir).join(', '))
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('a game cannot be named from outside')
// ---------------------------------------------------------------------------
{
  // The hole this replaced: /^[\w-]{1,64}$/ matched a Telegram id, so a browser
  // could POST {"id":"tg555"} and resume - or reset, which deleted first - any
  // Telegram player's game, and chat ids are short and enumerable.
  const h = await harness()
  const victim = 'tg555'
  const bot = browser(h.base)      // stands in for the chat: seeds a game to steal
  await bot.post('/api/session')
  const seeded = idsIn(h.dir)[0]
  await h.store.rename(seeded, victim)
  const before = JSON.stringify((await h.store.load(victim)).session)

  const thief = browser(h.base)
  const got = await thief.post('/api/session', { id: victim })
  ok('naming another game does not open it', got.body.kind === 'anon')
  ok('and what comes back is the thief\'s own new game',
     JSON.stringify(got.body.summary) !== 'undefined' && idsIn(h.dir).includes(victim))

  await thief.post('/api/say', { id: victim, text: 'skip' })
  ok('nor can a turn be taken in it',
     JSON.stringify((await h.store.load(victim)).session) === before)

  await thief.post('/api/reset', { id: victim })
  ok('nor can it be deleted', h.store.has(victim))
  ok('and it is still exactly as it was',
     JSON.stringify((await h.store.load(victim)).session) === before)

  // a cookie is not a thing a client can write either
  const forger = browser(h.base)
  forger.jar.set('mw', `v1.${victim}.${Math.floor(Date.now() / 1000)}.${'a'.repeat(64)}`)
  const forged = await forger.post('/api/session')
  ok('an unsigned cookie proves nothing', forged.body.kind === 'anon')
  ok('the game is still untouched',
     JSON.stringify((await h.store.load(victim)).session) === before)
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('signing in with Telegram')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  const a = browser(h.base)
  const guest = await playOn(a)
  const guestId = idsIn(h.dir)[0]
  ok('the guest got somewhere first', guest.summary.dayStep > 0 || guest.summary.rounds > 0,
     JSON.stringify(guest.summary))

  const r = await a.post('/api/auth/telegram', { user: login(777) })
  ok('the login is accepted', r.status === 200 && !r.body.choose)
  ok('and they are now themselves', r.body.kind === 'telegram' && r.body.name === 'Ada')
  ok('the game they were playing came with them',
     r.body.summary.dayStep === guest.summary.dayStep &&
     r.body.summary.balance === guest.summary.balance)
  ok('it is saved under their Telegram id, ready for the chat', h.store.has('tg777'))
  ok('and no longer under the guest id', !h.store.has(guestId))
  ok('the transcript came too', r.body.logLength === guest.logLength)
  await h.cleanup()
}
{
  const h = await harness()
  // a game already in the chat, and a browser that has done nothing with itself
  const seed = browser(h.base)
  await playOn(seed)
  await h.store.rename(idsIn(h.dir)[0], 'tg777')
  const inChat = (await h.store.load('tg777')).session.dayStep

  const a = browser(h.base)
  await a.post('/api/session')
  const r = await a.post('/api/auth/telegram', { user: login(777) })
  ok('an untouched guest game is not worth asking about', !r.body.choose)
  ok('and the chat game is what they get', r.body.summary.dayStep === inChat)
  ok('the empty guest game is cleared up', idsIn(h.dir).length === 1, idsIn(h.dir).join(', '))
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('two games, one player')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  const seed = browser(h.base)
  await playOn(seed)
  await h.store.rename(idsIn(h.dir)[0], 'tg777')

  const a = browser(h.base)
  const guest = await playOn(a)
  const guestId = idsIn(h.dir).find((i) => i !== 'tg777')

  const r = await a.post('/api/auth/telegram', { user: login(777) })
  ok('two real games are not silently merged', Boolean(r.body.choose))
  ok('both are described', r.body.choose.telegram.day > 0 && r.body.choose.anonymous.day > 0)
  ok('nothing has moved yet', h.store.has('tg777') && h.store.has(guestId))
  ok('and they are still a guest until they answer', a.jar.has('mwp'))

  const kept = await a.post('/api/auth/claim', { keep: 'telegram' })
  ok('keeping the Telegram game gives it to them', kept.body.kind === 'telegram')
  ok('the guest game is let go', !h.store.has(guestId))
  ok('the pending login is done with', !a.jar.has('mwp'))
  await h.cleanup()
}
{
  const h = await harness()
  const seed = browser(h.base)
  await playOn(seed)
  await h.store.rename(idsIn(h.dir)[0], 'tg777')

  const a = browser(h.base)
  const guest = await playOn(a)
  await a.post('/api/auth/telegram', { user: login(777) })
  const kept = await a.post('/api/auth/claim', { keep: 'anonymous' })
  ok('keeping this one replaces the Telegram game',
     kept.body.kind === 'telegram' && kept.body.summary.balance === guest.summary.balance)
  ok('and the replaced game is kept aside, not destroyed',
     readdirSync(h.dir).some((n) => n.startsWith('tg777.') && n.endsWith('.bak')),
     readdirSync(h.dir).join(', '))
  await h.cleanup()
}
{
  const h = await harness()
  const a = browser(h.base)
  await a.post('/api/session')
  const r = await a.post('/api/auth/claim', { keep: 'telegram' })
  ok('there is nothing to claim without a login', r.status === 409)
  const bad = await a.post('/api/auth/telegram', { user: { ...login(777), hash: 'f'.repeat(64) } })
  ok('a forged login is refused', bad.status === 401)
  ok('and refusing it changed nothing', (await a.post('/api/session')).body.kind === 'anon')
  const stale = await a.post('/api/auth/telegram', { user: login(777, 'Ada', { skew: 90000 }) })
  ok('a stale login is refused', stale.status === 401)
  const other = await a.post('/api/auth/telegram', { user: login(777, 'Ada', { token: '1:OTHER' }) })
  ok('a login signed by another bot is refused', other.status === 401)
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('signing out, and starting over')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  const a = browser(h.base)
  await playOn(a)
  await a.post('/api/auth/telegram', { user: login(777) })
  const out = await a.post('/api/auth/logout')
  ok('signing out makes them a guest again', out.body.kind === 'anon')
  ok('with a new game', out.body.summary.dayStep === 0)
  ok('and their Telegram game is left where it is', h.store.has('tg777'))

  const back = await a.post('/api/auth/telegram', { user: login(777) })
  ok('signing back in finds it again', back.body.kind === 'telegram' && !back.body.choose)
  await h.cleanup()
}
{
  const h = await harness()
  const a = browser(h.base)
  await playOn(a)
  await a.post('/api/auth/telegram', { user: login(777) })
  const fresh = await a.post('/api/reset')
  ok('starting over gives a new game', fresh.body.summary.dayStep === 0)
  ok('but not a new player', fresh.body.kind === 'telegram')
  ok('and it is still their id that holds it', h.store.has('tg777') && idsIn(h.dir).length === 1)
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('a cookie that outlived its game')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  const a = browser(h.base)
  await playOn(a)
  // what a restore from backup, or a development restart, looks like from here
  for (const id of idsIn(h.dir)) await h.store.remove(id)
  const r = await a.post('/api/say', { text: 'state' })
  ok('a turn into a game that is gone is not a dead end', r.status === 200)
  ok('a whole new standing comes back instead', r.body.reopened === true && r.body.log.length > 0)
  ok('and they are still the same player', r.body.kind === 'anon' && idsIn(h.dir).length === 1)
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('the things a script would do')
// ---------------------------------------------------------------------------
{
  const h = await harness({ rateLimit: createRateLimit({ windowMs: 60_000, max: 3 }) })
  const a = browser(h.base)
  const codes = []
  for (let i = 0; i < 5; i++) codes.push((await a.post('/api/session')).status)
  ok('a flood is turned away', codes.slice(0, 3).every((c) => c === 200) && codes[4] === 429,
     codes.join(', '))
  const health = await fetch(h.base + '/api/health').then((r) => r.json())
  ok('health says only what it should', health.ok === true && health.rules === undefined,
     JSON.stringify(health))
  await h.cleanup()
}
{
  const req = (headers, socket = '10.0.0.1') => ({ headers, socket: { remoteAddress: socket } })
  ok('a forwarded address is ignored by default',
     clientIp(req({ 'x-forwarded-for': '1.2.3.4' })) === '10.0.0.1')
  ok('and read when a proxy is trusted',
     clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), { trustProxy: true }) === '1.2.3.4')
}

// ---------------------------------------------------------------------------
section('one game, both clients')
// ---------------------------------------------------------------------------
{
  // The whole point of the deployment: a player signs in on the web, carries on
  // in the chat, and comes back to find the chat's turns waiting for them here.
  // One host, one store, one queue - which is why the deployed program is a
  // single process. grammY never reaches the network: updates go in by hand and
  // outbound calls are captured.
  const h = await harness()
  const BOT_INFO = {
    id: 4242, is_bot: true, first_name: 'Mackenzie', username: 'mw_test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  }
  const sent = []
  const made = createBot({
    token: TOKEN, host: h.host, artifacts: h.artifacts, queues: h.queues,
    pace: 0, botInfo: BOT_INFO,
  })
  let messageId = 100
  made.bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload })
    return { ok: true, result: { message_id: messageId++, date: 0, chat: { id: 777, type: 'private' } } }
  })
  let updateId = 0
  const inChat = (text) => made.bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++updateId, date: 0, text,
               chat: { id: 777, type: 'private' }, from: { id: 777, is_bot: false, first_name: 'Ada' } },
  })

  // on the web: play a little, then sign in, so the game is theirs
  const a = browser(h.base)
  await playOn(a)
  const signedIn = await a.post('/api/auth/telegram', { user: login(777) })
  ok('the game the guest played is now theirs', signedIn.body.kind === 'telegram')
  const beforeLog = signedIn.body.logLength
  const beforeStep = signedIn.body.summary.dayStep

  // in the chat: the same game, picked up where the browser left it
  await inChat('state')
  ok('the chat opens the game the browser was playing, not a new one',
     idsIn(h.dir).length === 1 && idsIn(h.dir)[0] === 'tg777', idsIn(h.dir).join(', '))

  // a turn that draws a chart, taken entirely in Telegram
  await inChat('h')
  ok('the chat sent a chart', sent.some((m) => m.method === 'sendPhoto'))

  // back in the browser
  const after = await a.post('/api/session')
  ok('the browser sees the turns taken in the chat', after.body.logLength > beforeLog,
     `${beforeLog} -> ${after.body.logLength}`)
  ok('and the game has moved on', after.body.summary.dayStep > beforeStep,
     `${beforeStep} -> ${after.body.summary.dayStep}`)

  const charts = after.body.log.filter((e) => e.kind === 'traces')
  ok('a chart drawn for the chat is in the browser transcript', charts.length > 0)
  ok('every chart in it has a picture to fetch', charts.every((e) => typeof e.png === 'string'),
     JSON.stringify(charts.map((e) => e.png)))
  const png = await fetch(h.base + charts[charts.length - 1].png)
  const bytes = Buffer.from(await png.arrayBuffer())
  ok('and that picture really is there', png.status === 200 &&
     bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
     `status ${png.status}, ${bytes.length} bytes`)

  // and the traffic still flows the other way
  const web = await a.post('/api/say', { text: 'state' })
  ok('a turn from the browser still works on the shared game', web.emissions !== null)
  ok('the queue is shared, so both clients are one line',
     made.sessions.queues === h.queues)
  await h.cleanup()
}

console.log(`\n  ${passes} passed${failures ? `, ${failures} FAILED` : ', all good'}\n`)
process.exit(failures ? 1 : 0)
