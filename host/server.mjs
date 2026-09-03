// server.mjs - the host for the HTML client.
//
// Plain HTTP and JSON, no framework. The rules live in core/ and know nothing
// about this file; it wires them to a physics backend, saves sessions, turns
// chart emissions into PNGs, and serves the page.
//
//   POST /api/session  {id?}        resume a saved game or start a new one
//   POST /api/say      {id, text}   one turn: emissions, choices, summary
//   POST /api/reset    {id}         start over
//   GET  /api/health
//
//   MW_MODEL          local | fake | http           (default local)
//   MW_PYTHON         interpreter for the local model
//   MW_QDRIVE_API_SRC qdrive-api's src/, for model/engine.py
//   MW_MOTH_KEY       or MW_MOTH_KEY_FILE, for the http model
//   MW_STATE_DIR      where saved games and rendered charts live
//   PORT              default 5090

import './env.mjs'

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, watchFile, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import { loadSpecs } from './specs.mjs'
import { createLocalModel } from './model-local.mjs'
import { createHttpModel, resolveMothKey } from './model-http.mjs'
import { renderEmission, RENDERABLE } from './render.mjs'
import { createStore } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLIENT = join(ROOT, 'client')
const ART = join(HERE, 'art')
const COPY_PATH = process.env.MW_COPY || join(ROOT, 'core', 'copy.yaml')
const STATE_DIR = process.env.MW_STATE_DIR || join(HERE, 'state')
const PNG_DIR = join(STATE_DIR, 'png')
const PORT = Number(process.env.PORT || 5099)

const envNum = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]))

// ---------------------------------------------------------------------------
// Rules, copy, model, game
// ---------------------------------------------------------------------------

export const rules = {
  steps: envNum('MW_STEPS', 10),
  daySteps: envNum('MW_DAY_STEPS', 27),
  weekDays: envNum('MW_WEEK_DAYS', 7),
  startBudget: envNum('MW_START_BUDGET', 1000),
  budgetFloor: envNum('MW_BUDGET_FLOOR', 500),
  quota: envNum('MW_QUOTA', 0.10),
  probation: process.env.MW_PROBATION !== '0',
  probationProfit: envNum('MW_PROBATION_PROFIT', 0),
  weekBonus: envNum('MW_WEEK_BONUS', 100),
  upgradeCost: envNum('MW_UPGRADE_COST', 10),
  regenSteps: envNum('MW_REGEN_STEPS', 9),
  nightSteps: envNum('MW_NIGHT_STEPS', 9),
  counterfactual: process.env.MW_COUNTERFACTUAL !== '0',
}

function readCopy () {
  const parsed = parseYaml(readFileSync(COPY_PATH, 'utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error(`${COPY_PATH}: not a mapping`)
  return createCopy(parsed)
}

export function buildModel (kind, { worlds, specs }) {
  switch (kind) {
    case 'fake': return createFakeModel({ worlds, steps: rules.steps })
    case 'local': return createLocalModel({ worlds })
    case 'http': return createHttpModel({ worlds, specs, key: resolveMothKey(),
      api: process.env.MW_MOTH_API || undefined, engine: process.env.MW_MOTH_ENGINE || undefined,
      log: (what, d) => console.log(`  moth ${what} ${JSON.stringify(d)}`) })
    default: throw new Error(`MW_MODEL=${kind}: expected local, fake or http`)
  }
}

const copy = readCopy()
const loaded = loadSpecs({ steps: rules.steps })
const MODEL_KIND = process.env.MW_MODEL || 'local'
const model = buildModel(MODEL_KIND, loaded)
const game = createGame({ copy, model, rules })
const store = createStore(STATE_DIR)

// a writer saves copy.yaml and the next message reads the new words
watchFile(COPY_PATH, { interval: 700 }, () => {
  try { game.setCopy(readCopy()); console.log('  copy: reloaded') } catch (e) { console.error(`  copy: reload failed, keeping previous (${e.message})`) }
})

// ---------------------------------------------------------------------------
// Delivery: an emission becomes something the page can show
// ---------------------------------------------------------------------------

let pngCounter = 0

async function deliver (id, emissions) {
  const out = []
  for (const e of emissions) {
    if (RENDERABLE.has(e.kind)) {
      const png = renderEmission(e)
      await mkdir(PNG_DIR, { recursive: true })
      const file = `${id}-${Date.now().toString(36)}-${(pngCounter++).toString(36)}.png`
      await writeFile(join(PNG_DIR, file), png)
      out.push({ ...e, png: `/png/${file}` })
    } else if (e.kind === 'art') {
      const file = ['png', 'jpg', 'jpeg', 'webp', 'gif'].map((x) => `${e.art}.${x}`).find((f) => existsSync(join(ART, f)))
      out.push({ ...e, url: file ? `/art/${file}` : null })
    } else {
      out.push(e)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Sessions, one turn at a time
// ---------------------------------------------------------------------------

const queues = new Map()
function enqueue (id, job) {
  const prev = queues.get(id) || Promise.resolve()
  const next = prev.then(job, job)
  queues.set(id, next.catch(() => {}))
  return next
}

const newId = () => randomBytes(6).toString('hex')

async function openSession (id) {
  let rec = id ? await store.load(id) : null
  if (rec) return { id, rec, fresh: false }
  id = newId()
  const S = game.newSession((Math.random() * 2 ** 31) | 0)
  rec = { session: S, log: [] }
  const r = await game.start(S)
  rec.log.push(...await deliver(id, r.emissions))
  await store.save(id, rec)
  return { id, rec, fresh: true }
}

async function turn (id, text) {
  return enqueue(id, async () => {
    const rec = await store.load(id)
    if (!rec) throw Object.assign(new Error('no such session'), { status: 404 })
    const S = rec.session
    let r
    try {
      r = await game.handle(S, text)
    } catch (e) {
      console.error(`  ${id}: turn failed:`, e?.stack || e?.message || e)
      const failed = [{ kind: 'text', text: game.copy.t('scenes.turn_failed') }]
      rec.log.push(...failed)
      await store.save(id, rec)
      return { emissions: failed, choices: game.choices(S), summary: game.summary(S), error: String(e?.message || e) }
    }
    const emissions = await deliver(id, r.emissions)
    rec.log.push(...emissions)
    await store.save(id, rec)
    return { emissions, choices: r.choices, summary: r.summary }
  })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

function json (res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
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

async function serveFile (res, dir, name) {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '')
  const path = join(dir, safe)
  if (!path.startsWith(dir) || !existsSync(path)) { res.writeHead(404); return res.end('not found') }
  const data = await readFile(path)
  res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
                       'Cache-Control': dir === PNG_DIR || dir === ART ? 'public, max-age=86400' : 'no-cache' })
  res.end(data)
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, CLIENT, 'index.html')
      if (url.pathname === '/app.js') return serveFile(res, CLIENT, 'app.js')
      if (url.pathname.startsWith('/art/')) return serveFile(res, ART, url.pathname.slice(5))
      if (url.pathname.startsWith('/png/')) return serveFile(res, PNG_DIR, url.pathname.slice(5))
      if (url.pathname === '/api/health') {
        return json(res, 200, { ok: true, model: model.name, worlds: loaded.worlds.length,
                                copyProblems: game.copy.problems, rules: game.rules })
      }
      res.writeHead(404); return res.end('not found')
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (url.pathname === '/api/session') {
        const { id, rec } = await openSession(typeof body.id === 'string' && /^[\w-]{1,64}$/.test(body.id) ? body.id : null)
        return json(res, 200, { id, log: rec.log, choices: game.choices(rec.session), summary: game.summary(rec.session) })
      }
      if (url.pathname === '/api/say') {
        if (typeof body.id !== 'string') return json(res, 400, { error: 'id required' })
        return json(res, 200, await turn(body.id, String(body.text ?? '')))
      }
      if (url.pathname === '/api/reset') {
        if (typeof body.id === 'string' && /^[\w-]{1,64}$/.test(body.id)) await store.remove(body.id)
        const { id, rec } = await openSession(null)
        return json(res, 200, { id, log: rec.log, choices: game.choices(rec.session), summary: game.summary(rec.session) })
      }
      res.writeHead(404); return res.end('not found')
    }
    res.writeHead(405); res.end('method not allowed')
  } catch (e) {
    console.error(`  ${req.method} ${url.pathname}:`, e?.stack || e?.message || e)
    json(res, e.status || 500, { error: String(e?.message || e) })
  }
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('\n  OFFICE 4B, 6 MACKENZIE WALK - host')
  console.log(`  copy     ${COPY_PATH}${game.copy.problems.length ? ` (${game.copy.problems.length} problem(s))` : ''}`)
  console.log(`  worlds   ${loaded.worlds.length} from ${loaded.dir}` +
              (loaded.skipped.length ? `, ${loaded.skipped.length} skipped` : '') +
              (loaded.missingStats.length ? `, ${loaded.missingStats.length} without volatility (run model/warmcache.py)` : ''))
  console.log(`  model    ${model.name}${model.info ? ' ' + JSON.stringify(model.info()) : ''}`)
  console.log(`  day      ${rules.daySteps} steps of ${rules.steps - 1} per world · week ${rules.weekDays} days`)
  console.log(`  state    ${STATE_DIR}`)
  if (model.check) {
    model.check().then((c) => console.log(`  moth     engine ${c.engine_id} ${c.enabled ? 'enabled' : 'DISABLED'}, ${c.credits_per_run} credit(s) a step`))
      .catch((e) => console.error(`  moth     engine check failed: ${e.message}`))
  }
  server.listen(PORT, () => console.log(`  listening on http://localhost:${PORT}\n`))
}
