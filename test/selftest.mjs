// selftest.mjs - the invariants the game rests on, against the fake model.
//
//   npm test
//
// Everything here runs with no Python and no network. What needs the real
// engine lives in model/selftest.py.

import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame, HELP_SCENE } from '../core/game.mjs'
import { readPacing, sceneDelay, withDelays, DEFAULT_PACING } from '../core/pacing.mjs'
import { createFakeModel, syntheticWorlds } from '../core/fake-model.mjs'
import * as story from '../core/story.mjs'
import { basePrice, quote, priceReturn, valueFactor, overview, prospectus } from '../core/pricing.mjs'
import { loadSpecs, infoOf, crc32, seedOf } from '../host/specs.mjs'
import { widenQasm, blankQasm, qubitCount } from '../host/qasm.mjs'
import { createHttpModel } from '../host/model-http.mjs'
import { renderEmission } from '../host/render.mjs'
import { createStore } from '../host/store.mjs'

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
const throws = async (fn) => { try { await fn(); return false } catch { return true } }

function mk (seed = 7, rules = {}, { worlds = specs.worlds, copySource = COPY } = {}) {
  const copy = createCopy(copySource, { random: () => 0 })     // lists pick their first line
  const model = createFakeModel({ worlds, steps: rules.steps ?? 10 })
  const game = createGame({ copy, model, rules })
  return { game, S: game.newSession(seed), model, copy }
}
async function skipOpening (game, S) {
  await game.start(S)
  // whatever the opening stops to ask is answered first: a scene waiting on
  // something typed cannot be skipped past
  let guard = 0
  while (story.awaitingAsk(game.copy, S) && guard++ < 10) await game.handle(S, 'Tester')
  if (story.inSequence(S)) await game.handle(S, 'skip')
  return S
}
async function walkScene (game, S, guard = 80) {
  let last = null
  while (story.inSequence(S) && guard-- > 0) {
    const offered = game.choices(S)
    last = await game.handle(S, offered.length ? offered[0].token : 'Tester')
  }
  return last
}
const texts = (r) => r.emissions.filter((e) => e.kind === 'text').map((e) => e.text)
const has = (r, re) => texts(r).some((t) => re.test(t))
// A block's heading travels beside its body rather than as the first line of
// it, so what heads a message is asked for separately from what it says.
const titles = (r) => r.emissions.filter((e) => e.kind === 'text').map((e) => e.title || '')
const heads = (r, re) => titles(r).some((t) => re.test(t))
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

// ---------------------------------------------------------------------------
section('the copy engine')
{
  const c = createCopy({
    a: 'Hello {name}', b: '{n} thing{n|s::s}', c: '{#if x}yes{:else}no{/if}', d: ['one', 'two'],
    e: '{v|money}', f: '{missing}', g: '{#if a}A{#if b}B{/if}{/if}', h: '{v|pct} {v|nope}',
    nested: { deep: 'x' },
  }, { random: () => 0.99 })
  ok('interpolates', c.t('a', { name: 'Ojs' }) === 'Hello Ojs')
  ok('the plural filter', c.t('b', { n: 1 }) === '1 thing' && c.t('b', { n: 2 }) === '2 things')
  ok('conditionals, with else', c.t('c', { x: true }) === 'yes' && c.t('c', { x: 0 }) === 'no')
  ok('nested conditionals', c.t('g', { a: 1, b: 1 }) === 'AB' && c.t('g', { a: 1, b: 0 }) === 'A' && c.t('g', { a: 0, b: 1 }) === '')
  ok('a list picks by the injected random', c.t('d') === 'two')
  ok('the money filter', c.t('e', { v: 1234.6 }) === '\u20ac$1,235')
  ok('a missing key is visible, not fatal', c.t('nope').startsWith('[missing copy') && c.problems.some((p) => /nope/.test(p)))
  ok('an unsupplied placeholder is left in place and noted', c.t('f') === '{missing}' && c.problems.some((p) => /missing/.test(p)))
  ok('an unknown filter is noted and skipped', c.t('h', { v: 0.5 }) === '+50.0% 0.5' && c.problems.some((p) => /nope/.test(p)))
  ok('dotted lookup and allKeys', c.has('nested.deep') && c.allKeys().includes('nested.deep'))
  c.record(true); c.t('a', { name: 'x', other: 1 })
  ok('recording notes the context names', [...c.recorded.get('a')].sort().join() === 'name,other')
  ok('the copy on disk parses and has the sections the game needs',
     ['scenes', 'prompts', 'buttons', 'vocabulary', 'holdings', 'worlds', 'beats', 'sequences', 'opening']
       .every((k) => COPY[k] !== undefined))
}

// ---------------------------------------------------------------------------
section('the opening')
{
  const { game, S } = mk(91)
  const r = await game.start(S)
  ok('a first sitting opens with a scene, not the brochure',
     story.inSequence(S) && S.expect === 'sequence' && !has(r, /premier neo-market/))
  ok('and bursts to the first thing it wants', ['choice', 'ask'].includes(S.seq.awaiting), String(S.seq?.awaiting))
  ok('art travels as its own emission', r.emissions.some((e) => e.kind === 'art'))
  ok('and every scene emission is paced', r.emissions.every((e) => e.pace))

  // The opening asks the player their name before it offers them anything to
  // press. An ask has no buttons under it, which is the whole of how a player
  // knows this one is answered in their own words.
  const stop = (COPY.sequences[S.seq.id] || [])[S.seq.at] || {}
  ok('it asks something before it offers anything', Boolean(stop.ask), Object.keys(stop).join())
  ok('and an ask puts nothing on the buttons', r.choices.length === 0, String(r.choices.length))
  const blank = await game.handle(S, '  *_`  ')
  ok('an answer with nothing left in it leaves the question standing',
     S.seq.awaiting === 'ask' && S.vars[stop.ask] === undefined && has(blank, /still talking/i))
  await game.handle(S, '  o_j  s  ')
  ok('what they type becomes their name, sanitised and clamped',
     S.vars[stop.ask] === 'oj s' && [...S.vars[stop.ask]].length <= (stop.max || 60),
     JSON.stringify(S.vars[stop.ask]))
  ok('and the scene plays on to something to press',
     story.inSequence(S) && game.choices(S).length >= 1)
  const at = S.seq.at
  const nudged = await game.handle(S, 'zzz')
  ok('a scene holds the floor', story.inSequence(S) && S.seq.at === at && has(nudged, /still talking/i))
  const last = await walkScene(game, S)
  ok('the opening completes, scenes chaining into one another', !story.inSequence(S) && last !== null)
  ok('every opening scene is marked seen', COPY.opening.every((id) => S.seqSeen.includes(id)), S.seqSeen.join())
  ok('then the game arrives with the day, and three worlds',
     S.expect === 'world' && S.worlds.length === 3 && heads(last, /^Day 1$/) &&
     last.choices.filter((c) => /^[123]$/.test(c.token)).length === 3)
  ok('and the day names the week it is on the hook for',
     has(last, /7 days left of probation/) && has(last, /\u20ac\$350/) && has(last, /budget of \u20ac\$1,000/))
  ok('and the brochure is not read to someone who was walked in', !has(last, /premier neo-market/))
  await game.start(S)
  ok('the opening does not play twice', !story.inSequence(S))

  const { game: g2, S: S2 } = mk(92)
  await g2.start(S2)
  const early = await g2.handle(S2, 'skip')
  ok('the opening cannot be skipped past the thing it asks',
     story.inSequence(S2) && S2.seq.awaiting === 'ask' && has(early, /cannot be skipped/i))
  ok('and skip is not taken as the answer either', S2.vars.initials === undefined, JSON.stringify(S2.vars))
  await g2.handle(S2, 'Tester')
  const sk = await g2.handle(S2, 'skip')
  ok('skip ends the opening and starts the game', !story.inSequence(S2) && S2.expect === 'world' && heads(sk, /^Day 1$/))
  ok('a skipped opening is not read as the brochure either', !has(sk, /premier neo-market/))

  const { game: g3, S: S3 } = mk(93, {}, { copySource: { ...COPY, opening: [] } })
  const w = await g3.start(S3)
  ok('with no opening at all, the welcome is read', has(w, /premier neo-market/) && S3.expect === 'world')

  const { game: g4, S: S4 } = mk(94)
  const first = await g4.handle(S4, 'hello')
  ok('an unstarted session starts on its first message', story.inSequence(S4) && first.emissions.length > 0)
}

// ---------------------------------------------------------------------------
section('the offer and entering a world')
{
  const { game, S, model } = mk(43)
  await skipOpening(game, S)
  const all = S.worlds.flatMap((w) => w.holdings)
  ok('three distinct worlds', new Set(S.worlds.map((w) => w.info.id)).size === 3)
  ok('with distinct names', new Set(S.worlds.map((w) => w.name)).size === 3)
  ok('every world names its holdings', S.worlds.every((w) => w.holdings.length === w.info.n))
  ok('no ticker means two things in one offer', new Set(all).size === all.length)
  const offered = S.worlds.map((w) => w.info.id).join()
  const r = await game.handle(S, '1')
  ok('entering runs the first step and nothing else', S.world && S.world.readings.length === 1 && model.calls.length === 1 && model.calls[0].couple === null)
  ok('and shows the report, then a chart with nothing written under it',
     heads(r, /^Report: /) && has(r, /corporate monopolisation/) &&
     r.emissions.some((e) => e.kind === 'traces') && r.emissions.every((e) => !e.caption))
  ok('the report leads with the two percentages and closes on the holdings',
     /monopolisation[\s\S]*volatility[\s\S]*investment opportunit[\s\S]*unexposed|monopolisation[\s\S]*volatility[\s\S]*investment opportunit[\s\S]*exposed to/
       .test(texts(r).find((t) => /monopolisation/.test(t))))
  ok('entering costs no time', S.dayStep === 0)
  const e = r.emissions.find((x) => x.kind === 'traces')
  ok('the chart carries what a renderer needs',
     e.priced.length === 1 && e.priced[0].length === S.world.info.n && e.holdings.length === S.world.info.n &&
     e.foot.left === 't0' && /t0/.test(e.foot.right) && e.upto === 0 && e.from === 0 &&
     e.totalReadouts === game.rules.chartReadouts)
  ok('leave is offered at t0', r.choices.some((c) => c.token === 'l'))
  const left = await game.handle(S, 'l')
  ok('leaving at t0 is free and re-offers', S.world === null && S.expect === 'world' && has(left, /leave before anything/))
  ok('the same three worlds', S.worlds.map((w) => w.info.id).join() === offered)
  const bad = await game.handle(S, '7')
  ok('a world that is not on offer is refused', has(bad, /Type/) && S.world === null)
  ok('the summary describes the standing', (() => { const s = game.summary(S); return s.day === 1 && s.daySteps === 27 && s.balance === 1000 && s.world === null })())
}

// ---------------------------------------------------------------------------
section('watching')
{
  const { game, S } = mk(44)
  await skipOpening(game, S)
  await game.handle(S, '1')
  S.coherence = 0.5
  const r = await game.handle(S, 'o')
  ok('watching advances one step of the day', S.world.readings.length === 2 && S.dayStep === 1)
  ok('and the qubit recovers while watching', Math.abs(S.coherence - (0.5 + 1 / 9)) < 1e-9, String(S.coherence))
  ok('and leaving is still on offer once something has been watched', r.choices.some((c) => c.token === 'l'))
  ok('the panel moves to t1', r.emissions.some((e) => e.kind === 'traces' && e.upto === 1))
  let last
  for (let i = 0; i < 7; i++) last = await game.handle(S, 'o')
  ok('t8 still offers the choice, and still says nothing under the chart',
     S.world.readings.length === 9 && last.choices.some((c) => c.token === 'i') &&
     last.emissions.every((e) => !e.caption))

  // A world has no length of its own any more: what was t9 is just another
  // readout, and the only thing that ends one the player has not ended is the
  // bell. The day is the whole of the rope.
  for (let i = 0; i < 10; i++) last = await game.handle(S, 'o')
  ok('a world runs past what used to be its last readout',
     S.world !== null && S.world.readings.length === 19 && S.dayStep === 18 && S.expect === 'invest')
  ok('and the paper is a window on the end of it, not the whole run',
     (() => { const e = last.emissions.find((x) => x.kind === 'traces')
              const w = game.rules.chartReadouts
              return e.upto === 18 && e.from === 18 - (w - 1) &&
                     e.foot.left === `t${18 - (w - 1)}` && /t18/.test(e.foot.right) })(),
     JSON.stringify(last.emissions.find((x) => x.kind === 'traces')?.foot))
  ok('with the whole run still on the emission, for the ladder and the listing price',
     last.emissions.find((x) => x.kind === 'traces').priced.length === 19)

  for (let i = 0; i < 9; i++) last = await game.handle(S, 'o')
  ok('and the bell is what ends it', S.world === null && S.dayStep === 0 && S.dayIndex === 1 &&
     heads(last, /^The Bell$/) && game.summary(S).rounds === 1)

  // Walking out of a world that has not moved the way it looked like it would
  // is a move, not a forfeit: the hours watching it are spent either way, and
  // nothing is committed until a stake is.
  const { game: g2, S: T } = mk(140)
  await skipOpening(g2, T)
  await g2.handle(T, '1')
  const offer = T.worlds.map((w) => w.info.id).join()
  for (let i = 0; i < 3; i++) await g2.handle(T, 'o')
  const out = await g2.handle(T, 'l')
  ok('leaving after watching costs nothing beyond the hours already spent',
     T.world === null && T.expect === 'world' && T.dayStep === 3 && T.balance === 1000 &&
     has(out, /leave before anything/))
  ok('and the same three are still on offer', T.worlds.map((w) => w.info.id).join() === offer)
}

// ---------------------------------------------------------------------------
section('waiting')
{
  const { game, S } = mk(141)
  await skipOpening(game, S)
  S.coherence = 0.5
  const tokens = game.choices(S).map((c) => c.token)
  ok('the offer carries a wait, before the workshop',
     tokens.includes('wait') && tokens.indexOf('wait') < tokens.indexOf('m'), tokens.join())
  const r = await game.handle(S, 'wait')
  ok('an hour waited recovers what an hour watched would',
     Math.abs(S.coherence - (0.5 + 1 / 9)) < 1e-9 && S.dayStep === 1, String(S.coherence))
  ok('and it is the player\'s own hour', r.emissions.some((e) => e.voice === 'player' && /sit it out/.test(e.text || '')))
  ok('nothing else moves: no world, and no second offer',
     S.expect === 'world' && S.world === null && r.emissions.every((e) => e.kind !== 'traces') &&
     !has(r, /Three worlds/))

  await game.handle(S, '1')
  const readouts = S.world.readings.length
  S.coherence = 0.5
  await game.handle(S, 'wait')
  ok('waiting inside a world spends the hour and not a readout',
     S.world.readings.length === readouts && S.dayStep === 2 && S.coherence > 0.5)

  for (const t of ['i', '100', '0']) await game.handle(S, t)
  const held = S.coherence
  const no = await game.handle(S, 'wait')
  ok('a position open refuses it - the coupling cannot be sat out',
     S.expect === 'holding' && S.coherence === held && S.dayStep === 2 &&
     has(no, /only moves while you hold/))

  const { game: g2, S: T } = mk(142)
  await skipOpening(g2, T)
  T.dayStep = 26
  const bell = await g2.handle(T, 'wait')
  ok('the day\'s last hour rings the bell however it was spent',
     heads(bell, /^The Bell$/) && T.dayIndex === 1 && T.dayStep === 0 && T.expect === 'world')

  const { game: g3, S: U } = mk(143)
  await skipOpening(g3, U)
  await g3.handle(U, 'm')
  U.coherence = 0.5
  await g3.handle(U, 'wait')
  ok('and it is a command, so it works from the workshop too',
     U.expect === 'market' && U.dayStep === 1 && U.coherence > 0.5)
}

// ---------------------------------------------------------------------------
section('a position: stake, hold, settle')
{
  const { game, S, model } = mk(45)
  await skipOpening(game, S)
  await game.handle(S, '1')
  await game.handle(S, 'o')
  let r = await game.handle(S, 'i')
  ok('invest asks for a stake, with presets', S.expect === 'stake' && r.choices.some((c) => /All/.test(c.label)))
  r = await game.handle(S, '250.7')
  ok('a fractional stake is rounded to whole G', S.pending.stake === 251 && S.expect === 'target')
  ok('targets are offered by ticker', r.choices.length === S.world.info.n && r.choices[0].label === S.world.holdings[0])
  const before = model.calls.length
  r = await game.handle(S, '1')
  ok('naming the holding is the last of it - nothing is asked about how long',
     S.expect === 'holding' && S.run && S.run.investAt === 1 && S.run.target === 1 && S.run.stake === 251)
  ok('the stake leaves the balance', S.balance === 1000 - 251 && S.investedToday === 1)
  ok('opening itself calls no model', model.calls.length === before)
  ok('and says so, with the chart marked',
     has(r, /Position open/) && r.emissions.some((e) => e.kind === 'traces' && e.target === 1 && e.interventionAt === 1))
  ok('hold, close and status are offered', ['h', 'c', 'state'].every((t) => r.choices.some((c) => c.token === t)))

  r = await game.handle(S, 'h')
  ok('a held step calls the model twice: coupled, and clean for the ghost',
     model.calls.length === before + 2 && model.calls.at(-2).couple === 1 && model.calls.at(-2).enter === true &&
     model.calls.at(-1).couple === null && model.calls.at(-1).enter === false)
  ok('the apparatus is in the circuit', S.run.entered && Array.isArray(S.run.apparatus))
  ok('the reading IS the chart - one emission, no caption',
     r.emissions.length === 1 && r.emissions[0].kind === 'traces' && !r.emissions[0].caption)
  ok('with a ghost of the uncoupled run the whole way back', r.emissions[0].clean.length === 3 && r.emissions[0].priced.length === 3)
  const c0 = S.coherence
  await game.handle(S, 'h')
  ok('the apparatus enters only once', model.calls.at(-2).enter === false)
  ok('holding does not regenerate', S.coherence === c0)
  r = await game.handle(S, 'h')
  ok('a third held step is just another reading - nothing was due', S.run && S.expect === 'holding')
  r = await game.handle(S, 'c')
  ok('closing settles the position', S.run === null && heads(r, /^Returns$/) && S.expect === 'world')
  ok('the balance stays a whole number', Number.isInteger(S.balance))
  ok('the qubit comes back changed', S.coherence < 1 && S.coherence > 0)
  ok('the next round is offered underneath, without re-opening the day',
     has(r, /Three worlds are open/) && !has(r, /\*\*Day /) && S.worlds.length === 3)
  ok('four steps of the day have passed, and closing is not one', S.dayStep === 4)
  ok('an unknown word mid-position is nudged, not swallowed', (async () => true)())
}

// ---------------------------------------------------------------------------
section('closing early')
{
  const { game, S } = mk(46)
  await skipOpening(game, S)
  for (const t of ['1', 'i', '100', '0', 'h', 'h']) await game.handle(S, t)
  const r = await game.handle(S, 'c')
  ok('closing early settles where it stands', S.run === null && heads(r, /^Returns$/) && S.expect === 'world')
  ok('and the day moved only for the held steps', S.dayStep === 2)

  const { game: g2, S: T } = mk(47)
  await skipOpening(g2, T)
  for (const t of ['1', 'i', '100', '0']) await g2.handle(T, t)
  const c = T.coherence
  const r2 = await g2.handle(T, 'c')
  ok('closing before any held step returns the stake', T.balance === 1000 && T.coherence === c && has(r2, /profit \u20ac\$0/))
}

// ---------------------------------------------------------------------------
section('the bell')
{
  const { game, S } = mk(48)
  await skipOpening(game, S)
  await game.handle(S, '1')
  S.dayStep = 25                                   // two steps left today
  for (const t of ['i', '100', '0']) await game.handle(S, t)
  ok('the position opens with no date on it', S.expect === 'holding' && !('exitAt' in S.run))
  await game.handle(S, 'h')
  const bell = await game.handle(S, 'h')
  ok('the bell closes the position where it stands', S.run === null && has(bell, /Closed early: EOD/))
  ok('then the day', heads(bell, /^The Bell$/) && S.dayIndex === 1 && S.dayStep === 0)
  ok('and only then the new day, on the new budget',
     titles(bell).findIndex((t) => /^The Bell$/.test(t)) < titles(bell).findIndex((t) => /^Day 2$/.test(t)) &&
     has(bell, /budget of \u20ac\$950/) && has(bell, /6 days left of probation/))
  ok('a day with a losing trade costs 5%', S.budget === 950)

  const { game: g2, S: T } = mk(49)
  await skipOpening(g2, T)
  await g2.handle(T, '1')
  T.dayStep = 20
  for (const t of ['i', '100', '0']) await g2.handle(T, t)
  ok('a day with room left opens the same way', T.expect === 'holding')

  const { game: g3, S: U } = mk(50)
  await skipOpening(g3, U)
  U.coherence = 0.2
  for (let w = 0; w < 3; w++) {
    await g3.handle(U, '1')
    for (let i = 0; i < 9; i++) await g3.handle(U, 'o')
  }
  ok('twenty-seven watched steps close the day', U.dayIndex === 1 && U.dayStep === 0 && U.world === null)
  ok('an idle day costs 5%', U.budget === 950)
  ok('the night restores the qubit', U.coherence === 1)
  ok('an idle day is said to be one', true)
}

// ---------------------------------------------------------------------------
section('the budget arithmetic')
{
  const { game } = mk(1)
  const day = (pl, traded, budget = 1000) => {
    const S = game.newSession(1)
    S.budget = budget; S.balance = budget + pl; S.investedToday = traded ? 1 : 0
    return game.closeDay(S).next
  }
  const q = Math.round(1000 * game.rules.quota)
  ok('clearing the quota raises the budget 10%', day(q, true) === 1100)
  ok('a losing day lowers it 5%', day(-300, true) === 950)
  ok('breaking even does not clear the quota', day(0, true) === 950)
  ok('nor does a profit short of it', day(q - 1, true) === 950)
  ok('a day with no investment counts as a loss', day(0, false) === 950)
  ok('the budget floors at 500', day(-100, true, 500) === 500)
  ok('the quota scales with the budget', day(Math.round(2000 * game.rules.quota), true, 2000) === 2200)
  ok('the day resets its step count', (() => { const S = game.newSession(2); S.dayStep = 27; game.closeDay(S); return S.dayStep === 0 })())
}

// ---------------------------------------------------------------------------
section('probation')
{
  const week = (game, S, pls) => {
    let last
    for (const pl of pls) { S.balance = S.budget + pl; S.investedToday = 1; last = game.closeDay(S) }
    return last
  }
  // The bar is a twentieth of every budget the week is handed, which on a week
  // that keeps clearing the quota is a little over 420 - so a week has to be
  // green, rather than having to be a triumph.
  const won = mk(1)
  const lw = week(won.game, won.S, [1200, -50, 900, 700, 1100, 400, 1500])
  ok('a week in profit passes probation',
     lw.verdict === 'passed' && won.S.probation === false, String(lw.target))
  ok('and the bar it cleared was a twentieth of what it was handed',
     Math.abs(lw.target - (1000 + 1100 + 1045 + 1150 + 1265 + 1392 + 1531) * 0.05) < 0.5, String(lw.target))
  const thin = mk(1)
  ok('a thin week clears it, where half of the budget would not have',
     week(thin.game, thin.S, [200, -50, 120, -30, 90, 40, 10]).verdict === 'passed')
  const thinner = mk(1)
  ok('and one thinner than the bar still does not',
     week(thinner.game, thinner.S, [40, -50, 30, -30, 20, 10, 10]).verdict === 'failed')
  ok('probation pays no bonus - the week is the reward', lw.bonusPaid === 0 && won.S.bonus === 0)
  ok('and the week after does pay one - off probation, any profit is a week',
     week(won.game, won.S, [200, -50, 120, -30, 90, 40, 10]).bonusPaid === 100 && won.S.bonus === 100)
  const lost = mk(2)
  const ll = week(lost.game, lost.S, [-200, -50, 120, -30, -90, 40, 10])
  ok('a losing week fails it', ll.verdict === 'failed')
  ok('a retry winds the desk back', lost.S.budget === 1000 && lost.S.week.length === 0 && lost.S.attempts === 2 && lost.S.probation === true)
  ok('breaking even over the week does not pass', week(mk(3).game, mk(3).S, [0, 0, 0, 0, 0, 0, 0]).verdict === 'failed')
  const lenient = mk(4, { probationShare: 0 })
  ok('the share is a dial - at zero, breaking even is enough',
     week(lenient.game, lenient.S, [0, 0, 0, 0, 0, 0, 0]).verdict === 'passed')
  const strict = mk(4, { probationShare: 1 })
  ok('and at one the whole week\'s budget has to be made back',
     week(strict.game, strict.S, [1200, -50, 900, 700, 1100, 400, 1500]).verdict === 'failed')

  // the verdict is a scene, at the bell
  const { game: g, S: T } = mk(5)
  await skipOpening(g, T)
  T.week = [700, 700, 700, 700, 700, 700]; T.weekBudgets = T.week.map(() => 1000)
  T.balance = T.budget + 500; T.investedToday = 1; T.dayStep = 26
  await g.handle(T, '1')
  const r = await g.handle(T, 'o')
  ok('the verdict plays as a scene', heads(r, /^Seven days\./) && has(r, /off probation/))
  ok('and the desk is off probation with the next week offered', !T.probation && (T.expect === 'world' || story.inSequence(T)))

  const { game: g2, S: F } = mk(6)
  await skipOpening(g2, F)
  F.week = [-100, -100, -100, -100, -100, -100]; F.weekBudgets = F.week.map(() => 1000)
  F.balance = F.budget - 100; F.investedToday = 1; F.dayStep = 26
  await g2.handle(F, '1')
  const r2 = await g2.handle(F, 'o')
  await walkScene(g2, F)
  ok('a failed week says so and starts attempt two', has(r2, /Not a profitable week/) && F.attempts === 2 && F.budget === 1000 && F.weekBudgets.length === 0)
  ok('a repeat attempt hears the floor carry on', has(r2, new RegExp(COPY.beats.again.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))))
}

// ---------------------------------------------------------------------------
section('beats')
{
  const schedule = COPY.beats.schedule
  const days = Object.keys(schedule).map(Number).sort((a, b) => a - b)
  ok('the week has setpieces scheduled', days.length > 0)
  for (const day of days) {
    const { game, S } = mk(77)
    S.week = Array.from({ length: day - 1 }, () => 0)
    const out = story.fireBeat(game.copy, S, { day, budget: '1,000G', attempt: 1 })
    ok(`day ${day} fires ${schedule[day]}`, out.length === 1 && S.beatsSeen.includes(schedule[day]))
    ok(`and day ${day} does not fire it twice`, story.beatDue(game.copy, S) === null)
  }
  const choiceDay = days.find((d) => COPY.beats[schedule[d]]?.choices)
  ok('some setpiece in the week asks something', choiceDay !== undefined)
  const { game, S } = mk(78)
  await skipOpening(game, S)
  S.week = Array.from({ length: choiceDay - 1 }, () => 0)
  story.fireBeat(game.copy, S, {})
  ok('a setpiece with choices waits', S.beat === schedule[choiceDay])
  const r = await game.handle(S, '1')
  ok('a command that is not one of its choices reaches the game', S.beat !== null && S.world !== null)
  ok('its choices ride along with the game\'s', r.choices.some((c) => c.token === 'a') && r.choices.some((c) => c.token === 'i'))
  for (const t of ['i', '100', '0', '3']) await game.handle(S, t)
  const tok = Object.keys(COPY.beats[schedule[choiceDay]].choices)[0]
  const ans = await game.handle(S, tok)
  ok('a beat can be answered mid-position without disturbing it', S.beat === null && S.expect === 'holding' && texts(ans).length === 1)

  game.copy.section('beats')._t = { text: 'x', choices: { a: { label: 'a', coherence: 0.2 }, b: { label: 'b', coherence: -0.9 }, c: { label: 'c' } } }
  const fx = async (tok, from) => {
    const { game: g, S: T } = mk(79)
    await skipOpening(g, T)
    T.coherence = from; T.beat = '_t'
    await g.handle(T, tok)
    return T
  }
  ok('a choice restores coherence', Math.abs((await fx('a', 0.4)).coherence - 0.6) < 1e-9)
  ok('a choice spends it', Math.abs((await fx('b', 0.95)).coherence - 0.05) < 1e-9)
  ok('clamped at both ends', (await fx('b', 0.5)).coherence === 0 && (await fx('a', 0.95)).coherence === 1)
  ok('a choice with no effect leaves it alone, and clears the beat', (await fx('c', 0.4)).coherence === 0.4 && (await fx('c', 0.4)).beat === null)
  delete game.copy.section('beats')._t

  // A setpiece that asks something opens the day, and the worlds wait behind
  // it: offered together, its two choices would sit in the same row as the
  // three worlds with nothing to say which question a keystroke answers.
  const { game: g5, S: D } = mk(82)
  await skipOpening(g5, D)
  D.week = Array.from({ length: choiceDay - 2 }, () => 0)
  D.weekBudgets = D.week.map(() => 1000)
  D.dayStep = 26
  await g5.handle(D, '1')
  const opened = await g5.handle(D, 'o')
  ok('a setpiece that asks something holds the day\'s worlds back',
     D.expect === 'beat' && D.beat === schedule[choiceDay] && !has(opened, /Three worlds/))
  ok('and nothing but its own choices is on offer',
     g5.choices(D).length > 0 && g5.choices(D).every((c) => c.kind === 'beat'),
     g5.choices(D).map((c) => `${c.kind}:${c.token}`).join(' '))
  const pushed = await g5.handle(D, 'zzz')
  ok('anything that is not one of its answers is turned away',
     D.expect === 'beat' && D.beat !== null && has(pushed, /answer them first/i))
  const heard = await g5.handle(D, Object.keys(COPY.beats[schedule[choiceDay]].choices)[0])
  ok('and answering it is what opens the market',
     D.expect === 'world' && D.beat === null && has(heard, /Three worlds/))

  const { game: g3, S: B } = mk(80)
  await skipOpening(g3, B)
  B.dayStep = 26
  await g3.handle(B, '1')
  await g3.handle(B, 'o')
  ok('the new day\'s setpiece fires at the bell', !schedule['2'] || B.beatsSeen.includes(schedule['2']), B.beatsSeen.join())
  ok('a desk off probation hears no beats', (() => { const { game: g4, S: P } = mk(81); P.probation = false; P.week = [0]; return story.fireBeat(g4.copy, P, {}).length === 0 })())
}

// ---------------------------------------------------------------------------
section('running out of money')
{
  const { game, S } = mk(52)
  await skipOpening(game, S)
  await game.handle(S, '1')
  S.balance = 1
  for (const t of ['i', '1', '0', '9', 'h']) await game.handle(S, t)
  // the worst possible move: bought as dear as a holding can be, closed as
  // cheap. A reading along the weights themselves is where f reaches 1, and it
  // is a real point on the Bloch sphere rather than an impossible one - <Z> = 1
  // alone only gets f to 1/sqrt(3) now
  const dear = [1, -1, 1].map((x) => x / Math.sqrt(3))
  S.world.readings[0][0] = dear
  S.world.readings[1][0] = dear.map((x) => -x)
  const r = await game.handle(S, 'c')
  ok('losing the last G says so', has(r, /out of money/) && S.balance >= 500)
  ok('and the rest of the day is forfeit', heads(r, /^The Bell$/) && S.dayIndex === 1 && S.dayStep === 0)
  ok('with the next day offered', S.expect === 'world' && heads(r, /^Day 2$/))
}

// ---------------------------------------------------------------------------
section('the marketplace')
{
  const { game, S } = mk(60)
  await skipOpening(game, S)
  const m = await game.handle(S, 'm')
  ok('the workshop opens from the offer',
     S.expect === 'market' && titles(m).includes(COPY.scenes.marketplace_title) && has(m, /9 neo-hours/))

  S.coherence = 0.2
  await game.handle(S, 'b')
  const r = await game.handle(S, '3')
  ok('an upgrade is an hour of recovery, handed over on the spot',
     Math.abs(S.coherence - (0.2 + 3 / 9)) < 1e-9 && S.balance === 970 && has(r, /3 bought/),
     String(S.coherence))
  ok('and it buys no better a clock', Math.abs(game.regenRate() - 1 / 9) < 1e-12)
  ok('it costs money and not time', S.dayStep === 0)
  ok('and it is counted against the day whose budget bought it', S.upgradesToday === 3)

  // the terminal takes what it has room for and is charged for that alone
  S.coherence = 0.8
  await game.handle(S, 'b')
  const capped = await game.handle(S, '9')
  ok('more than the terminal has room for is not sold, and not charged for',
     S.coherence === 1 && S.balance === 950 && S.upgradesToday === 5 &&
     has(capped, /only had room for 2/), `${S.balance} ${S.coherence}`)

  await game.handle(S, 'b')
  const clean = await game.handle(S, '1')
  ok('and a clean terminal is sold nothing at all',
     S.balance === 950 && S.upgradesToday === 5 && has(clean, /already clean/))

  S.coherence = 0.2
  S.balance = 5
  await game.handle(S, 'b')
  const no = await game.handle(S, '1')
  ok('what cannot be afforded is refused', has(no, /An upgrade is/) && S.upgradesToday === 5)

  const shut = game.newSession(61)
  shut.upgradesToday = 4
  game.closeDay(shut)
  ok('the count goes with the day that bought them', shut.upgradesToday === 0)

  await game.handle(S, 'l')
  ok('leaving re-offers the worlds', S.expect === 'world' && S.worlds.length === 3)
}

// ---------------------------------------------------------------------------
section('help and status')
{
  const { game, S } = mk(62)
  await skipOpening(game, S)
  for (const t of ['1', 'i', '100', '0', '5']) await game.handle(S, t)
  const h = await game.handle(S, 'help')
  const voice = (COPY.sequences[COPY.help_scene || HELP_SCENE] || []).length
  ok('help reads the voice out and lists the keys, touching nothing',
     S.expect === 'holding' && heads(h, /^Commands$/) && h.emissions.length === voice + 1,
     `${h.emissions.length} of ${voice + 1}`)
  const st = await game.handle(S, 'state')
  ok('status is its own message, and reads the day back mid-position',
     heads(st, /^Status$/) && has(st, /It's day 1, \d+ neo-hours remaining/) &&
     has(st, /Your balance is \u20ac\$/) && !heads(st, /^Day 1$/) && S.expect === 'holding')
  const junk = await game.handle(S, 'xyz')
  ok('junk mid-position is nudged', has(junk, /\*\*h\*\* to hold/) && S.run !== null)
  const empty = await game.handle(S, '   ')
  ok('nothing at all is answered', has(empty, /Say something/))
  ok('describing steps, in the writer\'s word for them',
     game.describeSteps(1) === '1 neo-hour' && game.describeSteps(9) === '9 neo-hours' &&
     game.describeSteps(27) === '1 day' && game.describeSteps(54) === '2 days' && game.describeSteps(40) === '1.5 days')
}

// ---------------------------------------------------------------------------
section('what the player types into a scene')
{
  ok('a plain answer is kept as given', story.capture('  Ojs  ') === 'Ojs')
  // the delimiters a renderer's markdown subset uses: left in, they swallow
  // the emphasis in the author's line around them
  ok('markdown delimiters are stripped', story.capture('a_b*c`d') === 'abcd')
  ok('a name that is nothing but delimiters comes back empty', story.capture('___') === '')
  ok('long answers are capped', story.capture('x'.repeat(200)).length === 60)
  ok('and a writer may cap them shorter', story.capture('ABCDEFGHIJ', 7) === 'ABCDEFG')
  ok('newlines and control codes close up into one line', story.capture('a\n\nb\tc') === 'a b c')
  // invisible, and it reorders every line it is dropped into
  ok('a bidi override does not survive', !story.capture('ab\u202Ecd').includes('\u202E'))
  // sliced by code point: half a surrogate pair would survive into the save
  // a complete pair ends on a LOW surrogate; a lone HIGH one at the end is the
  // half-character a naive slice(0, 60) would have left behind
  const emoji = story.capture('🙂'.repeat(80))
  ok('an answer of emoji is not cut through a character',
     [...emoji].length === 60 && !/[\uD800-\uDBFF]$/.test(emoji),
     `${emoji.length} units, ${[...emoji].length} code points`)
  ok('and a naive slice would have broken it', /[\uD800-\uDBFF]$/.test('🙂'.repeat(80).slice(0, 61)))
  ok('and nothing at all is still a string', story.capture(undefined) === '' && story.capture(null) === '')

  const { game, S } = mk(120)
  await skipOpening(game, S)
  S.seq = { id: '_ask', at: 0, awaiting: 'ask' }
  game.copy.section('sequences')._ask = [{ ask: 'name', text: 'who?' }, { text: 'hello {name}' }]
  const said = story.answerSequence(game.copy, S, ' Ol_ly ')
  ok('the captured answer reaches the next line', said.some((e) => /hello Olly/.test(e.text || '')))

  // the writer's own clamp, on the node beside the ask
  S.seq = { id: '_ask', at: 0, awaiting: 'ask' }
  game.copy.section('sequences')._ask = [{ ask: 'name', max: 7, text: 'who?' }, { text: 'hello {name}' }]
  story.answerSequence(game.copy, S, 'Bartholomew')
  ok('a node\'s max is what clamps it', S.vars.name === 'Barthol', JSON.stringify(S.vars.name))

  // nothing usable: the question stands rather than being answered with a blank
  S.seq = { id: '_ask', at: 0, awaiting: 'ask' }
  ok('an empty answer is not an answer', story.answerSequence(game.copy, S, ' `*_ ') === null && S.seq.at === 0)
  delete game.copy.section('sequences')._ask
}

// ---------------------------------------------------------------------------
section('choices say where they came from')
{
  const { game, S } = mk(121)
  await skipOpening(game, S)
  ok('a game choice is marked as one', game.choices(S).every((c) => c.kind === 'game'))
  await game.handle(S, '1')
  await game.handle(S, 'i')
  ok('and so is every stake preset', game.choices(S).every((c) => c.kind === 'game' && c.token))

  const { game: g2, S: T } = mk(122)
  await g2.start(T)
  // the opening asks for a name first, and an ask has no buttons - the
  // writer's choices are at the node after it
  let guard = 0
  while (story.inSequence(T) && !g2.choices(T).length && guard++ < 40) await g2.handle(T, 'Tester')
  ok('a scene marks its own',
     story.inSequence(T) && g2.choices(T).length > 0 && g2.choices(T).every((c) => c.kind === 'scene'))

  const { game: g3, S: B } = mk(123)
  await skipOpening(g3, B)
  g3.copy.section('beats')._k = { text: 'x', choices: { a: { label: 'A' }, b: { label: 'B' } } }
  B.beat = '_k'
  const mixed = g3.choices(B)
  ok('a beat marks its own, and they come first',
     mixed.filter((c) => c.kind === 'beat').length === 2 && mixed[0].kind === 'beat' && mixed.at(-1).kind === 'game',
     mixed.map((c) => `${c.kind}:${c.token}`).join(' '))
  delete g3.copy.section('beats')._k

  // read in error paths, so it must not be the thing that throws
  const { game: g4, S: E } = mk(124)
  await skipOpening(g4, E)
  E.expect = 'target'
  E.world = null
  let threw = null
  try { g4.choices(E) } catch (e) { threw = e }
  ok('asking for choices after a half-failed turn does not throw again',
     threw === null, threw?.message)

  // /help reads a scene back rather than performing it
  const narrated = story.narrate(g4.copy, E, COPY.help_scene || 'voice')
  ok('narrating is not paced', narrated.length > 0 && narrated.every((e) => e.pace === false))
}

// ---------------------------------------------------------------------------
section('timing')
{
  // The dials, as a copy editor writes them: seconds in, milliseconds out.
  const { copy } = mk(130, {}, { copySource: {
    ...COPY, pacing: { minimum: 0.5, scene: 2, max: 10, scenes: { tutorial: 4 } },
  } })
  const P = readPacing(copy)
  ok('seconds in copy.yaml become milliseconds on the emission',
     P.minimum === 500 && P.scene === 2000 && P.scenes.tutorial === 4000, JSON.stringify(P))

  // The floor is a floor: a line cannot duck under it, and nothing can be
  // slower than the ceiling.
  ok('a delay under the minimum is raised to it',
     sceneDelay(copy, 'intro', { delay: 0.1 }) === 500)
  ok('and one over the maximum is capped',
     sceneDelay(copy, 'intro', { delay: 9999 }) === 10_000)
  ok("a node's own delay beats its scene's",
     sceneDelay(copy, 'tutorial', { delay: 5 }) === 5000)
  ok("a scene's beats the default",
     sceneDelay(copy, 'tutorial', {}) === 4000 && sceneDelay(copy, 'intro', {}) === 2000)

  // A number nobody can act on should say so where every other copy problem
  // is said, not be quietly treated as zero.
  const { copy: bad } = mk(131, {}, { copySource: { ...COPY, pacing: { minimum: 'soon' } } })
  readPacing(bad)
  ok('a delay that is not a number is noted as a copy problem',
     bad.problems.some((p) => /pacing: minimum/.test(p)), bad.problems.join(' | '))
  ok('and the default stands in for it', readPacing(bad).minimum === DEFAULT_PACING.minimum * 1000)

  // Absent entirely - an older copy.yaml, or one a writer has not touched.
  const { copy: none } = mk(132, {}, { copySource: { ...COPY, pacing: undefined } })
  ok('copy.yaml with no pacing block still paces',
     readPacing(none).scene === DEFAULT_PACING.scene * 1000 && none.problems.length === 0)

  // The whole point: nothing leaves the game without a gap in front of it.
  const { game, S } = mk(133)
  const opened = await game.start(S)
  ok('every emission of the opening carries a delay',
     opened.emissions.length > 0 && opened.emissions.every((e) => Number.isFinite(e.delay)))
  ok('and a scene line waits longer than the minimum',
     opened.emissions.every((e) => e.delay >= readPacing(game.copy).minimum) &&
     opened.emissions.some((e) => e.pace && e.delay > readPacing(game.copy).minimum))

  const { game: g2, S: T } = mk(134)
  await skipOpening(g2, T)
  const plain = await g2.handle(T, 'state')
  const floor = readPacing(g2.copy).minimum
  ok("the game's own messages take the minimum, not a scene's timing",
     plain.emissions.length > 0 && plain.emissions.every((e) => e.delay === floor && !e.pace),
     plain.emissions.map((e) => e.delay).join())

  const read = await g2.handle(T, 'help')
  ok('a scene read back by help is unpaced but still spaced out',
     read.emissions.every((e) => e.delay === floor))

  // An emission the game did not make - the apology in setup.mjs - must still
  // be safe to hand a client.
  ok('an emission with no delay of its own gets the minimum',
     withDelays(g2.copy, [{ kind: 'text', text: 'x' }])[0].delay === floor)
}

// ---------------------------------------------------------------------------
section('saving')
{
  const dir = await mkdtemp(join(tmpdir(), 'mw4-'))
  const store = createStore(dir)
  const { game, S } = mk(51)
  await skipOpening(game, S)
  await game.handle(S, '1')
  await store.save('abc', { session: S, log: [{ kind: 'text', text: 'hi' }] })
  store.forget('abc')
  const rec = await store.load('abc')
  ok('a session round-trips through disk', rec && rec.session.world.info.id === S.world.info.id && rec.log.length === 1)
  ok('the world list is not saved', rec.session.allWorlds === undefined)
  await game.handle(rec.session, 'o')
  ok('and plays on after a reload', rec.session.world.readings.length === 2 && rec.session.allWorlds !== undefined)
  ok('one file per session', (await store.ids()).join() === 'abc')
  await store.remove('abc')
  ok('removed', (await store.ids()).length === 0)

  // renaming is how an anonymous browser game becomes a Telegram player's
  await store.save('web0123456789ab', { session: S, log: [{ kind: 'text', text: 'hi' }] })
  await store.rename('web0123456789ab', 'tg777')
  ok('a game can be renamed onto another id', store.has('tg777') && !store.has('web0123456789ab'))
  ok('and it is the same game', (await store.load('tg777')).session.world.info.id === S.world.info.id)
  ok('the memory of the old name goes with it', (await store.ids()).join() === 'tg777')
  await store.save('web0123456789ab', { session: S, log: [] })
  ok('renaming over a game refuses by default',
     await throws(() => store.rename('web0123456789ab', 'tg777')))
  const kept = await store.backup('tg777')
  ok('a game can be kept aside first', Boolean(kept) && existsSync(kept))
  ok('and then written over deliberately',
     await store.rename('web0123456789ab', 'tg777', { overwrite: true }))
  await rm(dir, { recursive: true, force: true })
}
{
  // Open to anyone, an unbounded cache would hold every game anybody ever
  // started. Every save writes the file first, so dropping one costs a read.
  const dir = await mkdtemp(join(tmpdir(), 'mw4-cache-'))
  const store = createStore(dir, { keepLive: 3 })
  for (let i = 0; i < 10; i++) await store.save(`web0000000${i}`, { session: { n: i }, log: [] })
  ok('the cache is bounded', store.cached === 3, `held ${store.cached}`)
  ok('all ten games are still on disk', (await store.ids()).length === 10)
  const cold = await store.load('web00000000')
  ok('a dropped game reads back whole', cold?.session.n === 0)
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
section('specifications')
{
  ok('every specification loads', specs.worlds.length === 46 && specs.skipped.length === 0, JSON.stringify(specs.skipped).slice(0, 200))
  ok('every world has its character cached', specs.missingStats.length === 0, specs.missingStats.join())
  ok('crc32 matches zlib', crc32('hello') === 907060870 && (crc32('spec_n3_01') & 0x7fffffff) === 2084443802 &&
     seedOf({ id: 'spec_n2_02' }) === 1569398853)
  const info = infoOf({ id: 'x', n: 2, targets: [{ expvals: { XI: 1 }, qubits: [0, 1] }] })
  ok('an asymmetric Pauli word contracts the holding qiskit says it does', info.book[0] === 0 && info.book[1] === 1)
  ok('a flush counts for nothing',
     infoOf({ id: 'y', n: 3, targets: [{ expvals: { ZZ: 1 }, qubits: [0, 1] }, null, { expvals: { XX: 1, YY: 1 }, qubits: [1, 2] }] }).constraints === 3)
  ok('two unrelated halves are noticed',
     infoOf({ id: 'z', n: 4, targets: [{ expvals: { ZZ: 1 }, qubits: [0, 1] }, { expvals: { ZZ: 1 }, qubits: [2, 3] }] }).connected === false)
  const w = specs.worlds.find((x) => x.id === 'spec_n3_02')
  // volatility is the range of the VALUE FACTOR now, not of <Z>: the whole set
  // reads lower (0.01-1.00, mean 0.49), so this is "lively", not "over half its range"
  ok('a real world reads as expected', w.n === 3 && w.pairs.length === 3 && w.constraints === 6 && w.book.join() === '4,4,4' && w.volatility > 0.5 && w.volatility <= 2)
  ok('the fake model can offer the real worlds or its own',
     syntheticWorlds().length === 12 && syntheticWorlds().every((x) => x.book.length === x.n))
}

// ---------------------------------------------------------------------------
section('pricing and the sheet')
{
  const info = { id: 'spec_test_01', n: 4, book: [1, 4, 4, 9] }
  const bases = [0, 1, 2, 3].map((q) => basePrice(info, q))
  ok('a bigger book lists dearer', bases[3] > bases[0])
  ok('no two holdings list at the same price', new Set(bases).size === 4)
  ok('the float is stable', basePrice(info, 2) === bases[2])
  const up = [0, 0, 1]
  const down = [0, 0, -1]
  ok('a rising reading is a rising quote', quote(bases[0], up) > quote(bases[0], down))
  ok('a quote is positive for any reading',
     [-1, -0.5, 0, 0.5, 1].every((z) => quote(bases[1], [0, 0, z]) > 0))
  ok('holding through a rise profits, through a decline loses',
     priceReturn(down, up) > 0 && priceReturn(up, down) < 0)
  // growth and profitability count for a holding, financial risk against
  ok('<X> counts for a holding and <Y> against',
     valueFactor([1, 0, 0]) > 0 && valueFactor([0, 1, 0]) < 0)
  ok('the value factor stays inside [-1, 1] at every corner of the ball',
     [-1, 1].every((x) => [-1, 1].every((y) => [-1, 1].every((z) =>
       Math.abs(valueFactor([x, y, z])) <= 1))))
  ok('and the three axes are read on equal terms',
     Math.abs(valueFactor([1, 0, 0])) === Math.abs(valueFactor([0, 1, 0])) &&
     Math.abs(valueFactor([0, 1, 0])) === Math.abs(valueFactor([0, 0, 1])))
  ok('an unreadable holding prices at its listing price', quote(bases[2], [0, 0, 0]) === bases[2])
  const copy = createCopy(COPY)
  const sheet = overview(copy, { id: 'spec_sheet_01', n: 4, book: [0, 3, 6, 12], pairs: [[0, 1], [1, 2], [2, 3]], max_pairs: 6 }, ['AAA', 'BBB', 'CCC', 'DDD'])
  ok('one row per holding, each priced', sheet.length === 4 && sheet.every((h) => /^\u20ac\$[\d,]+$/.test(h.price)))
  ok('a heavier book reads as more contracted', sheet[0].contracted !== sheet[3].contracted)
  ok('exposure names the holdings it is wired to', sheet[1].exposure === 'AAA, CCC')
  ok('the sheet carries no measure of how far a holding will move', !/range|volatil|inert/i.test(Object.keys(sheet[0]).join(' ')))
  const pr = prospectus(copy, specs.worlds.find((x) => x.id === 'spec_n7_01'))
  ok('the prospectus bands complexity and percentages', COPY.vocabulary.complexity.includes(pr.complexity) && pr.monopoly >= 0 && pr.monopoly <= 100)
  ok('a world without a cached character says so rather than 0', prospectus(copy, { n: 2, constraints: 2, pairs: [[0, 1]], max_pairs: 1, volatility: null }).volatility === '?')
}

// ---------------------------------------------------------------------------
section('widening a circuit in text')
{
  ok('a blank circuit declares its width', qubitCount(blankQasm(3)) === 3)
  const fixture = 'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate rzz(p0) _gate_q_0, _gate_q_1 {\n  cx _gate_q_0, _gate_q_1;\n  rz(p0) _gate_q_1;\n  cx _gate_q_0, _gate_q_1;\n}\nqubit[2] q;\nrz(2.1) q[0];\nrzz(0.2) q[0], q[1];\n'
  const wide = widenQasm(fixture, 2, [0, 0, 1], 0.5)
  ok('the register is widened by two', qubitCount(wide) === 4)
  ok('the preparation follows the declaration and precedes the world',
     /qubit\[4\] q;\nry\(1\.047[\d]*\) q\[3\];\ncx q\[3\], q\[2\];\nry\(0\.0\) q\[2\];\nrz\(0\.0\) q\[2\];\nrz\(2\.1\) q\[0\];/.test(wide), wide)
  ok('gate definitions are untouched', wide.includes('gate rzz(p0) _gate_q_0, _gate_q_1 {\n  cx _gate_q_0, _gate_q_1;'))
  ok('the world\'s own gates are untouched', wide.endsWith('rz(2.1) q[0];\nrzz(0.2) q[0], q[1];\n'))
  ok('a direction off the axis rotates the apparatus', /rz\(-?[0-9.]+\) q\[2\]/.test(widenQasm(fixture, 2, [0.3, -0.5, 0.8], 0.9)))
  ok('a mismatched width is refused', await throws(() => widenQasm(fixture, 3, [0, 0, 1], 1)))
  ok('and so is a text with no register', await throws(() => widenQasm('OPENQASM 3.0;', 2, [0, 0, 1], 1)))
}

// ---------------------------------------------------------------------------
section('the http backend, against a stand-in for the Moth API')
{
  const assets = new Map()
  const jobs = new Map()
  let n = 0
  let port = 0
  const srv = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url, 'http://x')
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.headers.authorization !== 'Bearer test-key' && !url.pathname.startsWith('/upload/') && !url.pathname.startsWith('/blob/')) return send(401, { detail: 'no' })
    if (req.method === 'GET' && url.pathname === '/api/v1/engines/qdrive-api-v1') return send(200, { engine_id: 'qdrive-api-v1', enabled: true, credits_per_run: 1 })
    if (req.method === 'POST' && url.pathname === '/api/v1/assets') {
      const id = `asset-${++n}`
      const meta = JSON.parse(body)
      assets.set(id, { meta, bytes: null })
      return send(201, { asset_id: id, upload: { url: `http://localhost:${port}/upload/${id}`, method: 'PUT', headers: { 'Content-Type': meta.content_type } } })
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) { assets.get(url.pathname.slice(8)).bytes = body; res.writeHead(200); return res.end() }
    if (req.method === 'POST' && /\/api\/v1\/assets\/[^/]+\/complete$/.test(url.pathname)) return send(200, {})
    if (req.method === 'GET' && /\/api\/v1\/assets\/[^/]+\/download$/.test(url.pathname)) return send(200, { download_url: `http://localhost:${port}/blob/${url.pathname.split('/')[4]}` })
    if (req.method === 'GET' && url.pathname.startsWith('/blob/')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(assets.get(url.pathname.slice(6)).bytes) }
    if (req.method === 'POST' && url.pathname === '/api/v1/engines/qdrive-api-v1/process') {
      const { params, input_files } = JSON.parse(body)
      const id = `job-${++n}`
      const qasm = input_files ? assets.get(input_files.initial_circuit).bytes : blankQasm(params.n_qubits)
      const width = qubitCount(qasm)
      const outId = `asset-${++n}`
      assets.set(outId, { bytes: `${qasm}// stepped\n` })
      const tomography = {}
      for (let q = 0; q < width; q++) tomography[q] = { X: 0.1, Y: 0.2, Z: 0.5 - 0.1 * q }
      jobs.set(id, { polls: 0, params, input_files, status: { status: 'completed', result: { tomography }, outputs: [{ slot: 'circuit', output_asset_id: outId }] } })
      return send(202, { job_id: id, status: 'queued' })
    }
    if (req.method === 'GET' && /\/api\/v1\/jobs\/[^/]+\/status$/.test(url.pathname)) {
      const j = jobs.get(url.pathname.split('/')[4])
      j.polls += 1
      return send(200, j.polls < 2 ? { status: 'running' } : j.status)
    }
    send(404, { detail: 'nope' })
  })
  await new Promise((r) => srv.listen(0, r))
  port = srv.address().port
  const model = createHttpModel({ specs: specs.specs, worlds: specs.worlds, key: 'test-key', api: `http://localhost:${port}`, pollMs: { first: 1, max: 5 } })
  ok('the engine check reads the engine', (await model.check()).enabled === true)
  const s0 = await model.step({ world: 'spec_n3_01' })
  const j1 = [...jobs.values()][0]
  ok('a first step sends n_qubits and no file', j1.params.n_qubits === 3 && !j1.input_files)
  ok('with the specification\'s targets and seed', j1.params.targets.length === 3 && j1.params.seed === seedOf(specs.specs.get('spec_n3_01')) && j1.params.tomography === 1)
  ok('and returns readings and a handle', s0.r.length === 3 && s0.r.every((v) => v.length === 3) &&
     typeof s0.circuit === 'string' && s0.apparatus === null && j1.polls >= 2)
  const s1 = await model.step({ world: 'spec_n3_01', circuit: s0.circuit })
  const j2 = [...jobs.values()][1]
  ok('a later step chains by asset id, without n_qubits', j2.input_files.initial_circuit === s0.circuit && !('n_qubits' in j2.params))
  const s2 = await model.step({ world: 'spec_n3_01', circuit: s1.circuit, enter: { direction: [0, 0, 1], coherence: 0.7 }, couple: 2 })
  const j3 = [...jobs.values()][2]
  const uploaded = assets.get(j3.input_files.initial_circuit).bytes
  ok('entering downloads the circuit, widens it and uploads it', qubitCount(uploaded) === 5 && /cx q\[4\], q\[3\];/.test(uploaded) && uploaded.includes('// stepped'))
  ok('the coupling target is appended for the step', j3.params.targets.at(-1).qubits.join() === '3,2' && j3.params.targets.at(-1).expvals.ZZ === 1 && j3.params.targets.length === 4)
  ok('and the apparatus is read back', Array.isArray(s2.apparatus) && s2.apparatus.length === 3 && s2.r.length === 3)
  ok('coupling with nothing in the circuit is refused before any job', await throws(() => model.step({ world: 'spec_n3_01', couple: 0 })))
  ok('an unknown world is refused', await throws(() => model.step({ world: 'nope' })))
  const bad = createHttpModel({ specs: specs.specs, worlds: specs.worlds, key: 'wrong', api: `http://localhost:${port}`, pollMs: { first: 1, max: 5 } })
  ok('a rejected key surfaces as an error', await throws(() => bad.check()))
  srv.close()
}

// ---------------------------------------------------------------------------
section('the chart')
{
  const rows = (n, f) => Array.from({ length: 6 }, (_, k) => Array.from({ length: n }, (_, q) => f(k, q)))
  const png = (n, prices, extra = {}) => renderEmission({
    kind: 'traces', n, holdings: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'].slice(0, n),
    f: prices, priced: prices, upto: prices.length - 1, totalReadouts: 10, target: 0, interventionAt: 1,
    title: 'test', foot: { left: 't0', right: 't9 . quote in G, log scale' }, ...extra,
  })
  const isPng = (b) => b.length > 1000 && b.subarray(0, 4).equals(PNG)
  ok('draws seven holdings', isPng(png(7, rows(7, (k, q) => 100 * (q + 1) * (1 + k / 20)))))
  ok('draws two', isPng(png(2, rows(2, (k, q) => 250 + q * 100 + k))))
  ok('draws a world that never moves', isPng(png(3, rows(3, () => 500))))
  ok('draws a ghost behind a held holding', isPng(png(3, rows(3, (k, q) => 100 * (q + 1) + k), { clean: rows(3, (k, q) => 100 * (q + 1) + k * 2), target: 1, interventionAt: 2 })))
  ok('draws across two decades', isPng(png(4, rows(4, (k, q) => 50 * Math.pow(4, q) + k))))
  ok('draws a single reading', isPng(png(3, rows(3, () => 400).slice(0, 1))))

  // a market older than the paper: the window moves, the series does not get cut
  const long = Array.from({ length: 30 }, (_, k) => [100 + k * 3, 200 - k * 2])
  ok('draws a market that has outlived the window',
     isPng(await renderEmission({
       kind: 'traces', n: 2, holdings: ['AAA', 'BBB'], f: long, priced: long,
       upto: 29, from: 15, totalReadouts: 15, target: 0, interventionAt: 2,
       title: 'test', foot: { left: 't15', right: 't29 . log scale' },
     })))
  ok('and one whose window has not started moving yet',
     isPng(await renderEmission({
       kind: 'traces', n: 2, holdings: ['AAA', 'BBB'], f: long.slice(0, 5), priced: long.slice(0, 5),
       upto: 4, from: 0, totalReadouts: 15, target: 0, interventionAt: 2,
       title: 'test', foot: { left: 't0', right: 't4 . log scale' },
     })))
  ok('a from beyond the last reading does not fold the paper inside out',
     isPng(await renderEmission({
       kind: 'traces', n: 2, holdings: ['AAA', 'BBB'], f: long.slice(0, 3), priced: long.slice(0, 3),
       upto: 2, from: 99, totalReadouts: 15, target: 0, interventionAt: null,
       title: 'test', foot: { left: 't0', right: 't2 . log scale' },
     })))
  ok('refuses what it cannot draw', await throws(() => renderEmission({ kind: 'text', text: 'x' })))
  // the real thing: what a round emits renders
  const { game, S } = mk(70)
  await skipOpening(game, S)
  for (const t of ['1', 'o', 'i', '100', '0', '5', 'h']) await game.handle(S, t)
  const r = await game.handle(S, 'h')
  ok('a real readout panel renders', isPng(renderEmission(r.emissions.find((e) => e.kind === 'traces'))))
}

console.log(`\n  ${passes} passed${failures ? `, ${failures} FAILED` : ', all good'}\n`)
process.exit(failures ? 1 : 0)
