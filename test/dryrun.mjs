// dryrun.mjs - plays a round in the terminal, with any backend.
//
//   node test/dryrun.mjs                   the fake model
//   node test/dryrun.mjs --model local     model/engine.py (needs the Python)
//   node test/dryrun.mjs --model http      the Moth API (needs a key; spends credits)
//   node test/dryrun.mjs --png /tmp/mw     also write every chart
//   node test/dryrun.mjs --seed 12
//
// The end of a probation week is six days away from where a dryrun starts, so
// there is no reading the verdict by playing to it:
//
//   node test/dryrun.mjs --week pass      the seventh day, cleared
//   node test/dryrun.mjs --week fail      the seventh day, missed
//   node test/dryrun.mjs --week again     a third attempt, missed again
//   node test/dryrun.mjs --week pass --pick b     take the other choice
//
// It winds the week on with the game's own bookkeeping - six days through
// closeDay, so the budgets compound the way they would have - and then rings
// the seventh day's bell for real. What prints is what a player gets: the
// bell, the night, the week's total, the verdict as a scene, and the day
// that follows it. No model is called on that path, so --week is as quick
// against the API as against the fake.

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
const week = arg('--week')
const picks = String(arg('--pick', '')).toLowerCase()
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

// Wrapped rather than cut off. A line trimmed at the terminal's edge is a line
// a copy editor cannot read, which is most of what this is for.
const WIDTH = 88
const INDENT = '          '
function wrap (s) {
  const out = []
  for (const line of strip(s ?? '').split('\n')) {
    if (!line.trim()) continue
    let cur = ''
    for (const word of line.trim().split(/\s+/)) {
      if (cur && `${cur} ${word}`.length > WIDTH) { out.push(cur); cur = word } else cur = cur ? `${cur} ${word}` : word
    }
    if (cur) out.push(cur)
  }
  return out
}

/**
 * One emission, as a block: a tag, then whatever it says.
 *
 * A heading is its own line in every client, so it leads here too, and a line
 * the writer marked as the player's own gets its own tag - which side of the
 * page a line takes is a good part of how a scene reads.
 */
function block (tag, head, e) {
  const lines = [...wrap(e.title), ...wrap(e.text)]
  if (!lines.length) return console.log(`  ${tag} ${head}`.trimEnd())
  // a line with nobody in front of it sits on the tag; a speaker or a picture
  // takes that line for itself and the words follow underneath
  console.log(head ? `  ${tag} ${head}` : `  ${tag} ${lines.shift()}`)
  for (const l of lines) console.log(`${INDENT}${l}`)
}

function show (r) {
  for (const [i, e] of r.emissions.entries()) {
    // The gap a client waits before this one, so a copy editor can read the
    // rhythm of a scene here rather than by playing it. Nothing waits before
    // the first of a burst - see core/pacing.mjs.
    const wait = i > 0 ? Number(e.delay) || 0 : 0
    if (wait) console.log(`  [wait ] ${(wait / 1000).toFixed(1)}s`)
    const tag = e.voice === 'player' ? '[you  ]' : '[text ]'

    if (e.kind === 'text') {
      sent.text += 1
      block(tag, e.speaker ? `${e.speaker}:` : '', e)
    } else if (e.kind === 'art') {
      sent.art += 1
      block('[art  ]', `${e.art}${e.voice === 'player' ? ' (you)' : ''}${e.speaker ? `  ${e.speaker}:` : ''}`, e)
    } else if (RENDERABLE.has(e.kind)) {
      const t0 = performance.now()
      const png = renderEmission(e)
      sent.charts += 1
      sent.bytes += png.length
      if (pngDir) writeFileSync(join(pngDir, `${String(++shot).padStart(2, '0')}-${e.kind}.png`), png)
      console.log(`  [chart] ${(png.length / 1024 | 0)}KB in ${Math.round(performance.now() - t0)}ms  ${e.title}`)
      for (const l of wrap(e.caption)) console.log(`${INDENT}${l}`)
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

/**
 * Play a scene out, a choice at a time.
 *
 * `--pick` is spent one letter per choice, so `--pick ba` takes the second
 * option at the first choice and the first at the next; anything not covered
 * falls to the first. Every option is printed either way - see the `[keys ]`
 * line - so what a branch not taken says is one more run away.
 */
let picked = 0
async function walk (S, guard = 60) {
  while (story.inSequence(S) && guard-- > 0) {
    const offered = game.choices(S)
    if (!offered.length) { await say(S, 'Ojs'); continue }   // an `ask` wants words
    const want = picks[picked++]
    const hit = offered.find((c) => String(c.token).toLowerCase() === want)
    await say(S, (hit || offered[0]).token)
  }
}

/**
 * The seventh day, about to close, on a week that lands the way asked.
 *
 * The six days before it are closed through the game's own closeDay rather
 * than written into the session, so the budgets compound and the week's target
 * is the one the arithmetic actually produces. The last day is left an hour
 * short, and `wait` spends it: the bell, and everything the bell brings.
 */
async function windToVerdict (S, how) {
  const R = game.rules
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  const day = (pl) => { S.balance = S.budget + pl; S.investedToday = 1; game.closeDay(S) }
  // a green day clears the daily quota and not much more, so the budget
  // compounds the way a real week's would rather than running away; a red one
  // just loses a little
  const green = () => Math.round(S.budget * R.quota) + 20
  const red = () => -Math.round(S.budget * 0.06)

  S.probation = true
  for (let i = 0; i < R.weekDays - 1; i++) day(how === 'pass' ? green() : red())

  // What the last day still owes. The target is a share of every budget the
  // week was handed, and the seventh is today's - so it can only be worked out
  // now, with the six before it closed.
  const target = (sum(S.weekBudgets) + S.budget) * R.probationShare
  const owed = target - sum(S.week)
  if (how === 'again') S.attempts = 3          // failures > 1 is what picks the shorter scene
  const last = how === 'pass' ? Math.max(green(), Math.ceil(owed) + green()) : red()

  S.balance = S.budget + last
  S.investedToday = 1
  S.dayStep = R.daySteps - 1
  console.log(`\n  wound to day ${S.dayIndex + 1}, attempt ${S.attempts} · the week stands at ` +
              `€$${sum(S.week) + last} against a target of €$${Math.round(target)}`)
  await say(S, 'wait')
  await walk(S)
}

console.log(`\n  model ${model.name} · ${loaded.worlds.length} worlds · seed ${seed}`)
const S = game.newSession(seed)
show(await game.start(S))
await walk(S)

if (week) {
  if (!['pass', 'fail', 'again'].includes(week)) {
    console.error(`\n  --week takes pass, fail or again, not '${week}'`)
    process.exit(1)
  }
  await windToVerdict(S, week)
  const s = game.summary(S)
  console.log(`\n  day ${s.day} · attempt ${s.attempts} · probation ${s.probation} · ` +
              `budget €$${s.budget} · coherence ${s.coherence} · expect '${s.expect}'`)
  process.exit(0)
}

await say(S, '1')
await say(S, 'o')
await say(S, 'i')
await say(S, '250')
await say(S, '1')
let held = 0
while (S.run && held++ < 12) await say(S, held === 3 ? 'c' : 'h')
await say(S, 'm')
await say(S, 'b')
await say(S, '2')
await say(S, 'l')

const s = game.summary(S)
console.log(`\n  sent ${sent.text} text, ${sent.art} art, ${sent.charts} charts (${(sent.bytes / 1024 | 0)}KB)`)
console.log(`  day ${s.day} step ${s.dayStep}/${s.daySteps} · budget €$${s.budget} · balance €$${s.balance} · coherence ${s.coherence} · expect '${s.expect}'`)
if (pngDir) console.log(`  charts written to ${pngDir}`)
