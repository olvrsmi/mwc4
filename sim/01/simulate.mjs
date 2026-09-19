// sim/01/simulate.mjs - the dumbest possible strategy, run on every world.
//
//   node sim/01/simulate.mjs                 all 46 worlds, local engine
//   node sim/01/simulate.mjs --model fake    no Python, invented physics
//   node sim/01/simulate.mjs --only spec_n3_01,spec_n7_02
//
// THE STRATEGY
//
//   enter the world, look at t0, put 100G on whichever holding is quoted
//   cheapest, coupling to it every step from t1, and close at the last readout.
//
// No judgement is exercised anywhere: the holding is chosen on its quote alone,
// which is `unit * (1 + book)^gamma * float * exp(sigma * f)`. Two of those
// three factors are historical accident - the book is how heavily the
// specification contracts the holding, and the float is a number drawn from the
// world's id when it listed - so "cheapest" is mostly a statement about the
// listing and not about where the price is going. That is the point of running
// it: it is the null strategy every other one has to beat.
//
// WHAT IT IS FAITHFUL TO
//
// The two rules that decide the outcome, both copied from core/game.mjs:
//
//   * the apparatus joins the circuit and couples on the step AFTER the stake
//     is placed, in one model.step call, so the reading the position opens at
//     is one nobody has touched
//   * the coupling runs every step for as long as the position is held, which
//     is what spends the apparatus. What comes back is its Bloch length
//
// The clean world is stepped alongside the held one, from the same circuit at
// t0, which is the ghost line on the chart: where the quote was going before
// anybody touched it.
//
// WHAT IT IS NOT
//
// Not the game. There is no budget, no day, no bell, no regeneration and no
// marketplace - every world is its own run and every run starts with a fully
// coherent apparatus on +Z, so the worlds can be compared with each other
// rather than with whatever the player had left by the time they got there.

import '../../host/env.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRICE, basePrice, quote, priceReturn, valueFactor, money, pct,
} from '../../core/pricing.mjs'
import { createFakeModel } from '../../core/fake-model.mjs'
import { loadSpecs } from '../../host/specs.mjs'
import { createLocalModel } from '../../host/model-local.mjs'
import { renderEmission } from '../../host/render.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const STEPS = Number(arg('--steps', process.env.MW_STEPS || 10))   // t0 .. t(STEPS-1)
const STAKE = Number(arg('--stake', 100))
const KIND = arg('--model', 'local')
const ONLY = (arg('--only') || '').split(',').filter(Boolean)

// The apparatus every run starts with: fully coherent, on +Z. The game
// randomises the transverse part per session; a fixed one keeps the only
// difference between these 46 runs the world itself.
const DIRECTION = [0, 0, 1]
const COHERENCE = 1

const norm = (v) => Math.hypot(v[0], v[1], v[2])
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4)
const signed = (v) => (v >= 0 ? '+' : '') + money(v)

// One table, written twice: to the terminal while it runs and to summary.txt
// when it finishes. console.log's %-14s is a C-ism node does not have.
const COLS = [15, 3, 5, 11, 11, 10, 10, 9]
const row = (cells) => cells
  .map((c, i) => (i >= 3 ? String(c).padStart(COLS[i] - 2).padEnd(COLS[i]) : String(c).padEnd(COLS[i])))
  .join('')
  .trimEnd()
const HEAD = row(['world', 'n', 'held', 'opened', 'closed', 'return', 'P/L', 'coherence'])
const runRow = (r) => row([r.id, r.n, `q${r.target}`, money(r.openedAt), money(r.closedAt),
                           pct(r.mult), signed(r.profit), r.coherence.toFixed(4)])

/** One world, start to finish. Returns everything worth writing down. */
async function play (model, info) {
  const { id, n } = info
  const bases = Array.from({ length: n }, (_, q) => basePrice(info, q, DEFAULT_PRICE))
  const price = (row) => row.map((r, q) => quote(bases[q], r, DEFAULT_PRICE))

  // t0: the world alone, with nobody in it
  const first = await model.step({ world: id, circuit: null, enter: null, couple: null })
  const readings = [first.r]
  let circuit = first.circuit

  // the cheapest quote on the board, which is what the strategy buys
  const opening = price(readings[0])
  let target = 0
  for (let q = 1; q < n; q++) if (opening[q] < opening[target]) target = q

  // the counterfactual: the same world, stepped from t0, never coupled
  let cleanCircuit = first.circuit
  const clean = []

  let apparatus = null
  let entered = false
  for (let k = 1; k < STEPS; k++) {
    const [held, ghost] = await Promise.all([
      model.step({
        world: id,
        circuit,
        // enter and couple travel together on the first held step - see hold()
        enter: entered ? null : { direction: [...DIRECTION], coherence: COHERENCE },
        couple: target,
      }),
      model.step({ world: id, circuit: cleanCircuit, enter: null, couple: null }),
    ])
    entered = true
    circuit = held.circuit
    readings.push(held.r)
    if (Array.isArray(held.apparatus)) apparatus = held.apparatus
    cleanCircuit = ghost.circuit
    clean.push(ghost.r)
  }

  const last = readings.length - 1
  const mult = priceReturn(readings[0][target], readings[last][target], DEFAULT_PRICE)
  const returned = Math.round(STAKE * (1 + mult))
  const coherence = apparatus ? clamp(norm(apparatus), 0, 1) : COHERENCE

  return {
    id, n, target, bases, readings, clean, apparatus, coherence,
    mult, returned, profit: returned - STAKE,
    openedAt: quote(bases[target], readings[0][target], DEFAULT_PRICE),
    closedAt: quote(bases[target], readings[last][target], DEFAULT_PRICE),
    f: readings.map((row) => row.map((r) => valueFactor(r, DEFAULT_PRICE))),
    priced: readings.map(price),
    ghost: [readings[0], ...clean].map(price),
  }
}

/** The game's own chart, drawn on the run that just finished. */
function chart (run) {
  return renderEmission({
    kind: 'traces',
    n: run.n,
    holdings: Array.from({ length: run.n }, (_, q) => `q${q}`),
    upto: run.readings.length - 1,
    totalReadouts: STEPS,
    target: run.target,
    interventionAt: 0,
    f: run.f,
    priced: run.priced,
    clean: run.ghost,
    title: `${run.id} - q${run.target} held t0 to t${STEPS - 1}, ${pct(run.mult)}`,
    foot: { left: 't0', right: `t${STEPS - 1}  .  quote in G, log scale` },
  })
}

/** What the apparatus came back as, which is the whole coherence economy. */
function coherenceReport (run) {
  const a = run.apparatus || [...DIRECTION].map((x) => x * COHERENCE)
  const lines = [
    run.coherence.toFixed(6),
    '',
    `world            ${run.id}  (n=${run.n})`,
    `held             q${run.target}, from t0 to t${STEPS - 1}`,
    `apparatus in     |r| ${COHERENCE.toFixed(6)}  on [${DIRECTION.join(', ')}]`,
    `apparatus out    |r| ${run.coherence.toFixed(6)}  ` +
      `on [${a.map((x) => f4(x)).join(', ')}]`,
    `spent            ${(COHERENCE - run.coherence).toFixed(6)}  ` +
      `(${(100 * (1 - run.coherence / COHERENCE)).toFixed(1)}% of what went in)`,
    '',
    'The apparatus is read after the last held step. Its length is the',
    'coherence the player carries into the next round; its direction is the',
    'axis they carry with it. ZZ = 1 is the only word the coupling drives, so',
    'a world that does not move <Z> much does not spend much.',
    '',
  ]
  return lines.join('\n')
}

async function main () {
  mkdirSync(HERE, { recursive: true })
  const loaded = loadSpecs({ steps: STEPS })
  const worlds = loaded.worlds.filter((w) => !ONLY.length || ONLY.includes(w.id))
  if (!worlds.length) throw new Error(`no worlds matched ${ONLY.join(',') || '(all)'}`)

  const model = KIND === 'fake'
    ? createFakeModel({ worlds: loaded.worlds })
    : createLocalModel({ worlds: loaded.worlds })

  console.log(`\n  ${worlds.length} worlds, model ${model.name}, ` +
              `${money(STAKE)} on the cheapest holding at t0, held to t${STEPS - 1}`)
  console.log(`  apparatus in at |r| ${COHERENCE} on [${DIRECTION.join(', ')}]\n`)
  console.log('  ' + HEAD)

  const rows = []
  const t0 = Date.now()
  for (const info of worlds) {
    let run
    try {
      run = await play(model, info)
    } catch (e) {
      console.log(`  ${info.id.padEnd(15)}FAILED  ${e.message}`)
      continue
    }
    writeFileSync(join(HERE, `${run.id}.png`), chart(run))
    writeFileSync(join(HERE, `${run.id}.txt`), coherenceReport(run))
    rows.push(run)
    console.log('  ' + runRow(run))
  }

  // the whole run, as one table and one line
  const won = rows.filter((r) => r.profit > 0).length
  const flat = rows.filter((r) => r.profit === 0).length
  const staked = STAKE * rows.length
  const back = rows.reduce((a, r) => a + r.returned, 0)
  const meanCoh = rows.reduce((a, r) => a + r.coherence, 0) / (rows.length || 1)

  const summary = [
    `${rows.length} worlds  .  ${money(STAKE)} on the cheapest holding at t0, held to t${STEPS - 1}`,
    `apparatus in at |r| ${COHERENCE.toFixed(3)} on [${DIRECTION.join(', ')}], coupling ZZ = 1 every held step`,
    '',
    HEAD,
    ...rows.map(runRow),
    '',
    `staked ${money(staked)}, returned ${money(back)}  .  ` +
      `${signed(back - staked)} overall ` +
      `(${pct(staked ? back / staked - 1 : 0)})`,
    `${won} of ${rows.length} profitable, ${flat} flat, ${rows.length - won - flat} down`,
    `mean coherence returned ${meanCoh.toFixed(4)}, ` +
      `worst ${Math.min(...rows.map((r) => r.coherence)).toFixed(4)}, ` +
      `best ${Math.max(...rows.map((r) => r.coherence)).toFixed(4)}`,
    '',
  ].join('\n')
  writeFileSync(join(HERE, 'summary.txt'), summary)

  console.log(`\n  staked ${money(staked)}, returned ${money(back)} ` +
              `(${pct(staked ? back / staked - 1 : 0)}), ${won}/${rows.length} profitable`)
  console.log(`  mean coherence back ${meanCoh.toFixed(4)}`)
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s  .  ${HERE}\n`)
  void ROOT
}

main().catch((e) => { console.error(e); process.exit(1) })
