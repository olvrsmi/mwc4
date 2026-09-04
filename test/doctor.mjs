// doctor.mjs - what a fresh clone still needs.
//
//   npm run doctor
//
// Two of the three physics backends need something this repository cannot
// carry: a Python with private packages in it, or a Moth API key. This says
// which of them are ready, where it looked, and what to run next. It fails
// only if the backend actually selected cannot run - the other two are
// reported and forgiven.

import '../host/env.mjs'

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELECTED = process.env.MW_MODEL || 'local'

let fatal = 0
let warned = 0
const say = (mark, name, detail = '') => console.log(`  ${mark}  ${name}${detail ? `\n         ${detail}` : ''}`)
const ok = (name, detail) => say('ok  ', name, detail)
const bad = (name, fix, counts = true) => { if (counts) fatal += 1; else warned += 1; say(counts ? 'MISS' : 'note', name, fix) }
const head = (name) => console.log(`\n  ${name}`)

// ---------------------------------------------------------------------------
head('node')
{
  const want = Number((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node || '>=18').replace(/\D/g, ''))
  const got = Number(process.versions.node.split('.')[0])
  if (got >= want) ok(`node ${process.versions.node}`, `package.json asks for >=${want}`)
  else bad(`node ${process.versions.node} is older than the required ${want}`, 'install a newer node; .nvmrc names the one this was built against')

  for (const dep of ['yaml', '@napi-rs/canvas']) {
    try {
      await import(dep)
      ok(`${dep} is installed`)
    } catch (e) {
      bad(`${dep} is missing`, `run: npm ci    (${String(e.message).split('\n')[0]})`)
    }
  }
  // the canvas binary is per-platform and optional in the lock, so importing
  // the package is not the same as being able to draw with it
  try {
    const { createCanvas } = await import('@napi-rs/canvas')
    const png = createCanvas(8, 8).toBuffer('image/png')
    ok('the chart renderer can draw', `${png.length} byte test png on ${process.platform}/${process.arch}`)
  } catch (e) {
    bad('@napi-rs/canvas has no working binary for this platform', `run: npm ci    (${String(e.message).split('\n')[0]})`)
  }
}

// ---------------------------------------------------------------------------
head('the words, the worlds and the pictures')
{
  try {
    const { parse } = await import('yaml')
    const { createCopy } = await import('../core/copy.mjs')
    const copy = createCopy(parse(readFileSync(join(ROOT, 'core', 'copy.yaml'), 'utf8')))
    const missing = ['scenes', 'prompts', 'buttons', 'vocabulary', 'worlds', 'holdings', 'sequences', 'opening']
      .filter((k) => copy.section(k) === undefined)
    if (missing.length) bad(`core/copy.yaml is missing ${missing.join(', ')}`, 'run: npm run copy-check')
    else ok(`core/copy.yaml parses`, `${copy.allKeys().length} entries`)
  } catch (e) {
    bad('core/copy.yaml could not be read', String(e.message).split('\n')[0])
  }

  try {
    const { loadSpecs } = await import('../host/specs.mjs')
    const s = loadSpecs()
    if (!s.worlds.length) bad('no world specifications found', `expected JSON files in ${s.dir}`)
    else if (s.missingStats.length) {
      bad(`${s.missingStats.length} of ${s.worlds.length} worlds have no cached volatility`,
        'the prospectus quotes it. Run: npm run warm    (needs the local Python)', false)
    } else ok(`${s.worlds.length} worlds load, all with a cached character`, `${s.dir}`)
    if (s.skipped.length) bad(`${s.skipped.length} specification(s) were rejected`, s.skipped.map((x) => `${x.id}: ${x.why}`).join('\n         '), false)
  } catch (e) {
    bad('the specifications could not be read', String(e.message).split('\n')[0])
  }

  for (const [what, dir, test] of [['art', join(ROOT, 'host', 'art'), /\.(png|jpe?g|webp|gif)$/i],
                                   ['fonts', join(ROOT, 'host', 'fonts'), /\.ttf$/i]]) {
    const n = existsSync(dir) ? readdirSync(dir).filter((f) => test.test(f)).length : 0
    if (n) ok(`${n} ${what} file(s)`)
    else bad(`no ${what} in host/${what}`, what === 'fonts' ? 'the chart will fall back to a system font and look different' : 'scenes will play their lines without pictures', false)
  }
}

// ---------------------------------------------------------------------------
head(`the physics — MW_MODEL=${SELECTED}`)
{
  const need = (kind) => (kind === SELECTED)

  // fake: nothing to check, it is why it exists
  ok('fake: always available', 'MW_MODEL=fake plays the whole game with no Python and no network')

  // local
  {
    const { findPython, MODEL_DIR } = await import('../host/model-local.mjs')
    const python = findPython()
    const where = process.env.MW_PYTHON ? 'MW_PYTHON' : existsSync(join(MODEL_DIR, '.venv')) ? 'model/.venv' : 'python3 on PATH'
    let version = null
    try { version = execFileSync(python, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch { /* not there */ }
    if (!version) {
      bad(`local: no interpreter at '${python}'`, 'create model/.venv, or set MW_PYTHON. See model/requirements.txt', need('local'))
    } else {
      const [maj, min] = version.replace(/[^\d.]/g, '').split('.').map(Number)
      const newEnough = maj > 3 || (maj === 3 && min >= 12)
      say(newEnough ? 'ok  ' : 'note', `local: ${version} (${where})`, newEnough ? python : `${python}\n         QDrive needs 3.12 or newer; set MW_PYTHON at one that is`)
      if (!newEnough) warned += 1

      const probe = (mod) => {
        try {
          execFileSync(python, ['-c', `import ${mod}`], { stdio: 'ignore', env: { ...process.env, PYTHONWARNINGS: 'ignore' } })
          return true
        } catch { return false }
      }
      const missing = ['qiskit', 'qiskit_aer', 'pydantic', 'qiskit_qasm3_import'].filter((m) => !probe(m))
      if (missing.length) bad(`local: that interpreter is missing ${missing.join(', ')}`, `run: ${python} -m pip install -r model/requirements.txt`, need('local'))
      else ok('local: qiskit and its friends are installed')

      if (!probe('qdrive')) {
        bad('local: QDrive is not installed in that interpreter',
          `private, so a clone cannot fetch it. Clone github.com/moth-quantum/QDrive, then:\n         ${python} -m pip install -e /path/to/QDrive`, need('local'))
      } else ok('local: QDrive is installed')

      // qdrive-api is loaded by path, not imported, so look for the files
      const candidates = [process.env.MW_QDRIVE_API_SRC,
                          join(ROOT, '..', 'vendor', 'qdrive-api', 'src'),
                          join(ROOT, 'model', 'vendor', 'qdrive-api', 'src'),
                          join(ROOT, '..', 'coupling-playground', 'qdrive-api', 'src')].filter(Boolean)
      const src = candidates.find((c) => existsSync(join(c, 'engine.py')))
      if (!src) {
        bad('local: no qdrive-api source found', 'private, so a clone cannot fetch it. Clone github.com/moth-quantum/qdrive-api\n' +
          '         and set MW_QDRIVE_API_SRC to its src/. Looked in:\n         ' + candidates.map((c) => resolve(c)).join('\n         '), need('local'))
      } else ok('local: qdrive-api source found', resolve(src))

      // and then the only check that really settles it
      if (need('local') && !missing.length && src) {
        try {
          const out = execFileSync(python, [join(ROOT, 'model', 'engine.py')], {
            input: JSON.stringify({ op: 'step', world: 'spec_n2_01' }),
            encoding: 'utf8', cwd: join(ROOT, 'model'), timeout: 180000,
            env: { ...process.env, MW_QDRIVE_API_SRC: src, PYTHONWARNINGS: 'ignore' },
          })
          const r = JSON.parse(out)
          if (r.ok) ok('local: the engine answered a real step', `${r.z.length} readings back`)
          else bad('local: the engine refused a step', r.error, true)
        } catch (e) {
          bad('local: the engine could not be run', String(e.message).split('\n').slice(0, 2).join(' | '), true)
        }
      }
    }
  }

  // http
  {
    let key = null
    try {
      const { resolveMothKey } = await import('../host/model-http.mjs')
      key = resolveMothKey()
    } catch { /* no key */ }
    if (!key) {
      bad('http: no Moth API key', 'set MW_MOTH_KEY, or MW_MOTH_KEY_FILE to a file holding one', need('http'))
    } else if (!need('http')) {
      ok('http: a key is set', 'not checked against the API — MW_MODEL is not http, and a check is a request')
    } else {
      try {
        const { createHttpModel } = await import('../host/model-http.mjs')
        const m = createHttpModel({ specs: new Map(), worlds: [], key, api: process.env.MW_MOTH_API || undefined, engine: process.env.MW_MOTH_ENGINE || undefined })
        const c = await m.check()
        if (c.enabled) ok(`http: engine ${c.engine_id} is enabled`, `${c.credits_per_run} credit(s) a step — and every held step is two`)
        else bad(`http: engine ${c.engine_id} is disabled`, 'ask whoever owns it to enable it')
      } catch (e) {
        bad('http: the engine could not be reached', String(e.message).replace(/Bearer \S+/g, 'Bearer ***').split('\n')[0])
      }
    }
  }
}

// ---------------------------------------------------------------------------
head('the clients')
{
  ok('browser: ready', 'npm start, or npm run fake for the invented physics')
  const local = process.env.MW_LOCAL === '1'
  const which = local ? 'TELEGRAM_BOT_TOKEN_LOCAL' : 'TELEGRAM_BOT_TOKEN'
  if (process.env[which]) {
    ok(`telegram: ${which} is set`, 'npm run telegram')
  } else {
    // not fatal: the Telegram client is one of two, and nothing else needs it
    bad(`telegram: ${which} is not set`,
      'get one from @BotFather and put it in .env. Telegram allows one long poll\n' +
      '         per token, so a laptop and a server need one each (MW_LOCAL=1 picks the second)', false)
  }
}

head('signing in')
{
  // None of this is fatal: the game plays without any of it. All of it is
  // needed before anyone can carry a game between the browser and the chat.
  if (process.env.MW_SECRET) {
    ok('cookies: MW_SECRET is set', 'saved games are found again after a restart')
  } else {
    bad('cookies: MW_SECRET is not set',
      'a new secret is made at every start, so a restart signs everyone out.\n' +
      '         fine on a laptop; set it before deploying:  openssl rand -hex 32', false)
  }
  const token = process.env[process.env.MW_LOCAL === '1' ? 'TELEGRAM_BOT_TOKEN_LOCAL' : 'TELEGRAM_BOT_TOKEN']
  const url = process.env.MW_PUBLIC_URL || ''
  if (process.env.MW_BOT_USERNAME && token) {
    ok(`telegram login: offered as @${process.env.MW_BOT_USERNAME}`,
      'the widget only signs anyone in on the domain @BotFather was given with\n' +
      '         /setdomain — get that wrong and it renders, then does nothing, silently')
  } else {
    bad('telegram login: not offered',
      `needs ${[!token && 'a bot token', !process.env.MW_BOT_USERNAME && 'MW_BOT_USERNAME']
        .filter(Boolean).join(' and ')}. Without it the browser plays guests only`, false)
  }
  if (url && !/^https:/i.test(url) && !/localhost|127\.0\.0\.1/.test(url)) {
    bad('cookies: MW_PUBLIC_URL is not https',
      'the session cookie is only marked Secure for an https origin', false)
  }
}

// ---------------------------------------------------------------------------
console.log()
if (fatal) {
  console.log(`  ${fatal} thing(s) needed for MW_MODEL=${SELECTED} are missing${warned ? `, and ${warned} worth a look` : ''}.`)
  console.log(`  MW_MODEL=fake needs none of them: npm run fake\n`)
  process.exit(1)
}
console.log(`  ready for MW_MODEL=${SELECTED}${warned ? `, with ${warned} thing(s) worth a look` : ''}.\n`)
