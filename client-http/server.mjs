// server.mjs - the browser client, and the small HTTP server behind it.
//
// Plain HTTP and JSON, no framework. The rules live in core/ and the assembly
// in host/setup.mjs; what is here is only the part that is about being a web
// page: routes, static files, and turning a chart into a URL the page can load.
//
//   POST /api/session  {id?}        resume a saved game or start a new one
//   POST /api/say      {id, text}   one turn: emissions, choices, summary
//   POST /api/reset    {id}         start over
//   GET  /api/health
//
//   PORT              default 5090
//   MW_MODEL          local | fake | http           (default local)
//   MW_STATE_DIR      where saved games and rendered charts live
//   the rest are in .env.example

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, extname, normalize, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost, createSessions, printBanner, ART, STATE_DIR } from '../host/setup.mjs'
import { renderEmission, RENDERABLE, artPath } from '../host/render.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PNG_DIR = join(STATE_DIR, 'png')
const PORT = Number(process.env.PORT || 5090)

const host = createHost()
const { game, model, loaded } = host

// ---------------------------------------------------------------------------
// Delivery: an emission becomes something the page can show
//
// The page is plain HTML with no drawing of its own, so a chart is rendered
// here and left on disk for the browser to fetch. The numbers stay on the
// emission either way, for anyone who would rather draw their own.
// ---------------------------------------------------------------------------

let pngCounter = 0

async function deliver (id, emissions) {
  const out = []
  for (const e of emissions) {
    if (RENDERABLE.has(e.kind)) {
      let png = null
      try {
        png = renderEmission(e)
      } catch (err) {
        // A chart that will not draw costs the reading its picture, not the
        // player their turn. The page falls back to the caption alone.
        console.error(`  ${id}: could not draw a '${e.kind}': ${err.message}`)
      }
      if (!png) { out.push({ ...e, png: null }); continue }
      await mkdir(PNG_DIR, { recursive: true })
      const file = `${id}-${Date.now().toString(36)}-${(pngCounter++).toString(36)}.png`
      await writeFile(join(PNG_DIR, file), png)
      out.push({ ...e, png: `/png/${file}` })
    } else if (e.kind === 'art') {
      const file = artPath(e.art)
      out.push({ ...e, url: file ? `/art/${basename(file)}` : null })
    } else {
      out.push(e)
    }
  }
  return out
}

const sessions = createSessions(host, { deliver })
const newId = () => randomBytes(6).toString('hex')
const validId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v)

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

/** A session's standing, in the shape the page expects. */
const standing = (id, rec) => ({
  id, log: rec.log, choices: game.choices(rec.session), summary: game.summary(rec.session),
})

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, HERE, 'index.html')
      if (url.pathname === '/app.js') return serveFile(res, HERE, 'app.js')
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
        const { id, rec } = await sessions.open(validId(body.id) ? body.id : newId())
        return json(res, 200, standing(id, rec))
      }
      if (url.pathname === '/api/say') {
        if (!validId(body.id)) return json(res, 400, { error: 'id required' })
        return json(res, 200, await sessions.turn(body.id, String(body.text ?? '')))
      }
      if (url.pathname === '/api/reset') {
        // a reset earns a new id, so a stale page holding the old one cannot
        // write back into the game that replaced it
        if (validId(body.id)) await host.store.remove(body.id)
        const { id, rec } = await sessions.open(newId())
        return json(res, 200, standing(id, rec))
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
  printBanner(host, 'browser')
  server.listen(PORT, () => console.log(`  listening on http://localhost:${PORT}\n`))
}
