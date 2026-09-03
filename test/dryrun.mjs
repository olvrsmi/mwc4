// dryrun.mjs - plays a round in the terminal, with any backend.
//
//   node test/dryrun.mjs                   the fake model
//   node test/dryrun.mjs --model local     model/engine.py (needs the Python)
//   node test/dryrun.mjs --model http      the Moth API (needs a key; spends credits)
//   node test/dryrun.mjs --png /tmp/mw     also write every chart
//   node test/dryrun.mjs --seed 12

import '../host/env.mjs'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import * as story from '../core/story.mjs'
import { loadSpecs } from '../host/specs.mjs'
import { createLocalModel } from '../host/model-local.mjs'
import { createHttpModel, resolveMothKey } from '../host/model-http.mjs'
import { renderEmission, RENDERABLE } from '../host/render.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const kind = arg('--model', process.env.MW_MODEL_DRYRUN || 'fake')
const pngDir = arg('--png')
const seed = Number(arg('--seed', 7))
if (pngDir) mkdirSync(pngDir, { recursive: true })

const copy = createCopy(parseYaml(readFileSync(join(ROOT, 'core', 'copy.yaml'), 'utf8')))
const loaded = loadSpecs()
const model = kind === 'fake' ? createFakeModel({ worlds: loaded.worlds })
  : kind === 'local' ? createLocalModel({ worlds: loaded.worlds })
    : createHttpModel({ worlds: loaded.worlds, specs: loaded.specs, key: resolveMothKey(),
                        api: process.env.MW_MOTH_API || undefined, engine: process.env.MW_MOTH_ENGINE || undefined })
const game = createGame({ copy, model })

let shot = 0
const sent = { text: 0, art: 0, charts: 0, bytes: 0 }
const strip = (s) => String(s).replace(/\*\*/g, '')

function show (r) {
  for (const e of r.emissions) {
    if (e.kind === 'text') {
      sent.text += 1
      const lines = strip(e.text).split('\n')
      console.log(`  [text ] ${e.speaker ? `${e.speaker}: ` : ''}${lines[0].slice(0, 96)}`)
      for (const l of lines.slice(1)) if (l.trim()) console.log(`          ${l.slice(0, 96)}`)
    } else if (e.kind === 'art') {
      sent.art += 1
      console.log(`  [art  ] ${e.art}${e.speaker ? `  ${e.speaker}:` : ''}`)
      for (const l of strip(e.text || '').split('\n')) if (l.trim()) console.log(`          ${l.slice(0, 96)}`)
    } else if (RENDERABLE.has(e.kind)) {
      const t0 = performance.now()
      const png = renderEmission(e)
      sent.charts += 1
      sent.bytes += png.length
      if (pngDir) writeFileSync(join(pngDir, `${String(++shot).padStart(2, '0')}-${e.kind}.png`), png)
      console.log(`  [chart] ${(png.length / 1024 | 0)}KB in ${Math.round(performance.now() - t0)}ms  ${e.title}`)
      for (const l of strip(e.caption || '').split('\n')) if (l.trim()) console.log(`          ${l.slice(0, 96)}`)
    } else {
      console.log(`  [?????] nothing shows a '${e.kind}' emission`)
    }
  }
  if (r.choices.length) console.log(`  [keys ] ${r.choices.map((c) => c.label).join('  |  ')}`)
}

async function say (S, token) {
  console.log(`\n  > ${token}`)
  const t0 = performance.now()
  const r = await game.handle(S, token)
  show(r)
  const ms = Math.round(performance.now() - t0)
  if (ms > 200) console.log(`  (${ms}ms)`)
  return r
}

console.log(`\n  model ${model.name} · ${loaded.worlds.length} worlds · seed ${seed}`)
const S = game.newSession(seed)
show(await game.start(S))
let guard = 0
while (story.inSequence(S) && guard++ < 60) {
  const offered = game.choices(S)
  await say(S, offered.length ? offered[0].token : 'Ojs')
}
await say(S, '1')
await say(S, 'o')
await say(S, 'i')
await say(S, '250')
await say(S, '1')
await say(S, '5')
let held = 0
while (S.run && held++ < 12) await say(S, held === 3 ? 'c' : 'h')
await say(S, 'm')
await say(S, 'b')
await say(S, '2')
await say(S, 'l')

const s = game.summary(S)
console.log(`\n  sent ${sent.text} text, ${sent.art} art, ${sent.charts} charts (${(sent.bytes / 1024 | 0)}KB)`)
console.log(`  day ${s.day} step ${s.dayStep}/${s.daySteps} · budget ${s.budget}G · balance ${s.balance}G · coherence ${s.coherence} · expect '${s.expect}'`)
if (pngDir) console.log(`  charts written to ${pngDir}`)
