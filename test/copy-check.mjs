// copy-check.mjs - verify copy.yaml before anyone plays on it.
//
//   npm run copy-check
//
// Two directions, because either can be wrong:
//   * every key the code asks for exists in copy.yaml
//   * every {placeholder} a message uses is one the engine actually supplies
//
// The second needs to know what each message is given. Rather than keep a
// schema, this plays through the game with a recording copy object and notes
// the real context of every message it renders - so the check tests what the
// game actually does, not what a list claims it does.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame, HELP_SCENE } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import * as story from '../core/story.mjs'
import { DEFAULT_PACING } from '../core/pacing.mjs'
import { loadSpecs } from '../host/specs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COPY_PATH = process.env.MW_COPY || join(ROOT, 'core', 'copy.yaml')
const ART = join(ROOT, 'host', 'art')

const problems = []
const source = parseYaml(readFileSync(COPY_PATH, 'utf8'))
const HELP = typeof source.help_scene === 'string' && source.help_scene ? source.help_scene : HELP_SCENE
const copy = createCopy(source)
copy.record(true)

// --- play through, so the common paths are all rendered at least once -------
const specs = loadSpecs()
const game = createGame({ copy, model: createFakeModel({ worlds: specs.worlds }) })
const S = game.newSession(11)
await game.start(S)
const walk = async () => {
  let guard = 0
  while (story.inSequence(S) && guard++ < 80) {
    const offered = game.choices(S)
    await game.handle(S, offered.length ? offered[0].token : 'Ojs')
  }
}
const say = async (...tokens) => { for (const t of tokens) await game.handle(S, t) }
await walk()
await say('1', 'o', 'i', '250', '1', ...Array(8).fill('h'))        // watched, then held to the end of the world
await say('1', 'i', '100', '0', 'h', 'c')                          // closed by hand
S.dayStep = 26
await say('1', 'i', '100', '0', 'h')                               // the bell closes it, and the day
await say('1', 'o', 'l')                                           // a nudge or two
await say('m', 'b', '10', 'l')                                     // the workshop
// six days on the books, and a seventh that clears the week's target
S.week = [700, 700, 700, 700, 700, 700]; S.weekBudgets = S.week.map(() => 1000)
S.dayStep = 26; S.balance = S.budget + 500; S.investedToday = 1
await say('1', 'o')                                                // the week ends in a verdict
await walk()
S.probation = true; S.attempts = 2
await say('help', 'state', 'zzz', '')

const seen = copy.recorded

// --- 1. keys referenced in code that copy.yaml does not define -------------
// Every renderer too: a client asks for words of its own, and a key only it
// uses would otherwise read as stale and be deleted by the next writer.
const sources = ['core/game.mjs', 'core/story.mjs', 'core/pricing.mjs', 'host/setup.mjs',
                 'client-http/server.mjs', 'client-telegram/bot.mjs']
const referenced = new Set(['opening', 'worlds', 'holdings', 'beats.schedule', 'beats.again', 'help_scene',
                            `sequences.${HELP}`, 'sequences.probation_passed', 'sequences.probation_failed'])
for (const f of sources) {
  const src = readFileSync(join(ROOT, f), 'utf8')
  for (const m of src.matchAll(/\.(?:t|list|pick)\(\s*'([\w.]+)'/g)) referenced.add(m[1])
  for (const m of src.matchAll(/\.t\(\s*[^)]*\?\s*'([\w.]+)'\s*:\s*'([\w.]+)'/g)) { referenced.add(m[1]); referenced.add(m[2]) }
}
const lookup = (k) => copy.section(k)
for (const key of [...referenced].sort()) {
  if (lookup(key) === undefined) problems.push(`missing key: '${key}' is used in code`)
}

// --- 2. placeholders and filters inside each template ----------------------
const PLACEHOLDER = /\{([\w.]+)((?:\|[^}]*)?)\}/g
const CONDITION = /\{#if\s+([\w.]+)\}/g
const known = new Set(copy.filterNames())

function checkTemplate (key, tpl, supplied) {
  if (typeof tpl !== 'string') return
  const opens = (tpl.match(/\{#if/g) || []).length
  const closes = (tpl.match(/\{\/if\}/g) || []).length
  if (opens !== closes) problems.push(`unbalanced conditional in '${key}': ${opens} {#if} but ${closes} {/if}`)
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    for (const spec of m[2].split('|').filter(Boolean)) {
      const name = spec.split(':')[0]
      if (!known.has(name)) problems.push(`unknown filter '${name}' in '${key}' (available: ${[...known].join(', ')})`)
    }
    if (supplied && !supplied.has(m[1])) {
      problems.push(`'${key}' uses {${m[1]}}, which the engine does not supply (it gives: ${[...supplied].sort().join(', ')})`)
    }
  }
  for (const m of tpl.matchAll(CONDITION)) {
    if (supplied && !supplied.has(m[1])) problems.push(`'${key}' tests {#if ${m[1]}}, which the engine does not supply`)
  }
}

/**
 * A choice's key is the token the player sends, and a chat client puts it in a
 * button's callback data - which Telegram caps at 1 to 64 BYTES and rejects at
 * send time, not at build time. Caught here instead, where the writer is.
 */
function checkToken (where, tok) {
  const bytes = Buffer.byteLength(String(tok))
  if (bytes < 1 || bytes > 64) {
    problems.push(`${where}.${tok} is ${bytes} bytes; a choice key must be 1 to 64 - a button cannot carry it`)
  }
}

for (const key of copy.allKeys()) {
  if (key.startsWith('sequences.') || key.startsWith('beats.')) continue     // checked below, with their own contexts
  const v = lookup(key)
  if (Array.isArray(v)) v.forEach((line) => checkTemplate(key, line, seen.get(key)))
  else checkTemplate(key, v, seen.get(key))
}

// Scenes are rendered against what a scene can read: the budget, the coherence,
// whatever the engine has parked on the session (the probation arithmetic, so
// that `help` can read the tutorial back outside a running scene), whatever an
// `ask` captured, and for the verdicts the week's numbers.
//
// The session's own vars are taken from the play-through above rather than
// listed here, so a name the engine starts supplying needs no edit in this file.
const asks = new Set()
for (const nodes of Object.values(source.sequences || {})) {
  if (Array.isArray(nodes)) for (const n of nodes) if (n && n.ask) asks.add(String(n.ask))
}
const sceneCtx = new Set(['budget', 'coherence', ...Object.keys(S.vars || {}), ...asks])
const verdictCtx = new Set([...sceneCtx, 'total', 'total_raw', 'paid', 'bonus', 'pot', 'attempt', 'failures', 'again'])
for (const [id, nodes] of Object.entries(source.sequences || {})) {
  if (!Array.isArray(nodes)) { problems.push(`sequences.${id} should be a list of nodes`); continue }
  const ctx = id.startsWith('probation_') ? verdictCtx : sceneCtx
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') { problems.push(`sequences.${id}[${i}] is not a node`); return }
    checkTemplate(`sequences.${id}[${i}].text`, node.text, ctx)
    checkTemplate(`sequences.${id}[${i}].speaker`, node.speaker, ctx)
    if (node.choices !== undefined) {
      if (typeof node.choices !== 'object' || Array.isArray(node.choices)) {
        problems.push(`sequences.${id}[${i}].choices must be a mapping keyed by token (a, b, c...)`)
      } else {
        for (const [tok, c] of Object.entries(node.choices)) {
          if (!c || typeof c !== 'object') { problems.push(`sequences.${id}[${i}].choices.${tok} is not a choice`); continue }
          if (!c.label) problems.push(`sequences.${id}[${i}].choices.${tok} has no label`)
          checkToken(`sequences.${id}[${i}].choices`, tok)
          checkTemplate(`sequences.${id}[${i}].choices.${tok}.label`, c.label, ctx)
          checkTemplate(`sequences.${id}[${i}].choices.${tok}.reply`, c.reply, ctx)
        }
      }
    }
  })
}
const beatCtx = new Set(['day', 'budget', 'attempt'])
for (const [id, spec] of Object.entries(source.beats || {})) {
  if (id === 'schedule') continue
  if (id === 'again') { copy.list('beats.again').forEach((l) => checkTemplate('beats.again', l, new Set())); continue }
  if (typeof spec === 'string') { checkTemplate(`beats.${id}`, spec, beatCtx); continue }
  if (!spec || typeof spec !== 'object') { problems.push(`beats.${id} should be text or a mapping`); continue }
  checkTemplate(`beats.${id}.text`, spec.text, beatCtx)
  if (spec.choices && (typeof spec.choices !== 'object' || Array.isArray(spec.choices))) {
    problems.push(`beats.${id}.choices must be a mapping keyed by token`)
  }
  for (const [tok, c] of Object.entries(spec.choices || {})) {
    if (!c?.label) problems.push(`beats.${id}.choices.${tok} has no label`)
    checkToken(`beats.${id}.choices`, tok)
    checkTemplate(`beats.${id}.choices.${tok}.reply`, c?.reply, new Set(['coherence']))
  }
}
for (const [day, id] of Object.entries(source.beats?.schedule || {})) {
  if (!Number.isInteger(Number(day)) || Number(day) < 1) problems.push(`beats.schedule has a day '${day}' that is not a day number`)
  if (source.beats?.[id] === undefined) problems.push(`beats.schedule day ${day} names '${id}', which is not written`)
}

// --- 2b. timing -------------------------------------------------------------
//
// Seconds, everywhere. A delay is as easy to mistype as a placeholder is, and
// a node that waits an hour looks exactly like a game that has hung.
const pacing = source.pacing
const isSeconds = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const maxDelay = isSeconds(pacing?.max) ? pacing.max : DEFAULT_PACING.max
if (pacing !== undefined && (!pacing || typeof pacing !== 'object' || Array.isArray(pacing))) {
  problems.push("pacing: should be a mapping of 'minimum', 'scene', 'max' and 'scenes'")
} else if (pacing) {
  for (const name of ['minimum', 'scene', 'max']) {
    if (pacing[name] !== undefined && !isSeconds(pacing[name])) {
      problems.push(`pacing.${name} is '${pacing[name]}'; it should be a number of seconds`)
    }
  }
  if (isSeconds(pacing.minimum) && isSeconds(pacing.max) && pacing.minimum > pacing.max) {
    problems.push(`pacing.minimum (${pacing.minimum}s) is longer than pacing.max (${pacing.max}s)`)
  }
  const named = new Set([...Object.keys(source.sequences || {}), ...Object.keys(source.beats || {}), 'again'])
  for (const [id, v] of Object.entries(pacing.scenes || {})) {
    if (!isSeconds(v)) problems.push(`pacing.scenes.${id} is '${v}'; it should be a number of seconds`)
    else if (v > maxDelay) problems.push(`pacing.scenes.${id} is ${v}s, longer than pacing.max (${maxDelay}s)`)
    if (!named.has(id)) problems.push(`pacing.scenes names '${id}', which is not a sequence or a beat`)
  }
}

/** Every `delay:` a writer typed, wherever it is. */
function checkDelay (where, value) {
  if (value === undefined) return
  if (!isSeconds(value)) problems.push(`${where}.delay is '${value}'; it should be a number of seconds`)
  else if (value > maxDelay) problems.push(`${where}.delay is ${value}s, longer than pacing.max (${maxDelay}s)`)
}
for (const [id, nodes] of Object.entries(source.sequences || {})) {
  if (!Array.isArray(nodes)) continue
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') return
    checkDelay(`sequences.${id}[${i}]`, node.delay)
    for (const [tok, c] of Object.entries(node.choices || {})) {
      if (c && typeof c === 'object') checkDelay(`sequences.${id}[${i}].choices.${tok}`, c.delay)
    }
  })
}
for (const [id, spec] of Object.entries(source.beats || {})) {
  if (id === 'schedule' || id === 'again' || !spec || typeof spec !== 'object') continue
  checkDelay(`beats.${id}`, spec.delay)
  for (const [tok, c] of Object.entries(spec.choices || {})) {
    if (c && typeof c === 'object') checkDelay(`beats.${id}.choices.${tok}`, c.delay)
  }
}

// --- 3. scenes the engine names --------------------------------------------
for (const id of ['probation_passed', 'probation_failed']) {
  const nodes = lookup(`sequences.${id}`)
  if (!Array.isArray(nodes) || nodes.length === 0) {
    problems.push(`sequences.${id} is empty or missing - a probation week ends on it, and the engine has nothing else to say`)
  }
}
const helpNodes = lookup(`sequences.${HELP}`)
if (!Array.isArray(helpNodes) || helpNodes.length === 0) {
  problems.push(`sequences.${HELP} is empty or missing - help reads it out (name another with help_scene:)`)
} else {
  const stops = helpNodes.map((n, i) => (n && (n.choices || n.ask) ? i : -1)).filter((i) => i >= 0)
  if (stops.length) problems.push(`sequences.${HELP} node(s) ${stops.join(', ')} stop to ask something, but help only reads a scene out - nothing would hear the answer`)
}
for (const id of copy.list('opening')) {
  if (!Array.isArray(lookup(`sequences.${id}`))) problems.push(`opening names '${id}', which is not a scene in sequences`)
}

// --- 4. keys defined but never used ---------------------------------------
const unusedSkip = ['worlds', 'holdings', 'vocabulary', 'sequences', 'beats', 'opening', 'chatter', 'pacing']
const unused = copy.allKeys().filter((k) =>
  !referenced.has(k) && !unusedSkip.some((p) => k === p || k.startsWith(p + '.')) && !seen.has(k))

// --- 5. art, both directions ------------------------------------------------
const wanted = new Set()
const collectArt = (node) => {
  if (!node || typeof node !== 'object') return
  if (typeof node.art === 'string') wanted.add(node.art)
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(collectArt)
    else if (v && typeof v === 'object') collectArt(v)
  }
}
collectArt(source.sequences)
collectArt(source.beats)
const onDisk = existsSync(ART)
  ? new Set(readdirSync(ART).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).map((f) => f.replace(/\.[^.]+$/, '')))
  : new Set()
const artMissing = [...wanted].filter((n) => !onDisk.has(n)).sort()
const artUnused = [...onDisk].filter((n) => !wanted.has(n)).sort()

// --- report ---------------------------------------------------------------
console.log(`\n  ${COPY_PATH}`)
console.log(`  ${copy.allKeys().length} entries · ${referenced.size} referenced in code · ${seen.size} exercised by a play-through\n`)
if (copy.problems.length) {
  console.log('  noted while playing:')
  for (const p of copy.problems) console.log(`    ${p}`)
  console.log()
}
if (unused.length) {
  console.log('  not used anywhere (harmless, but perhaps stale):')
  for (const k of unused) console.log(`    ${k}`)
  console.log()
}
if (artMissing.length) console.log(`  art a scene asks for with no file yet: ${artMissing.join(', ')}`)
if (artUnused.length) console.log(`  art in host/art that no scene asks for: ${artUnused.join(', ')}`)
if (artMissing.length || artUnused.length) console.log()

const all = [...problems, ...copy.problems.filter((p) => !/should be a list/.test(p))]
if (!all.length) {
  console.log('  no problems found.\n')
  process.exit(0)
}
console.log(`  ${all.length} problem${all.length === 1 ? '' : 's'}:\n`)
for (const p of all) console.log(`    ${p}`)
console.log()
process.exit(1)
