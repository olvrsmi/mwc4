// game.mjs - the rules of Office 4B, 6 Mackenzie Walk.
//
// A pure state machine. It knows nothing about Telegram, HTTP, files, clocks
// or pictures. Two things are injected: `copy` (see copy.mjs) for every word,
// and `model` for the physics - anything with
//
//   worlds()                                -> [info]
//   step({ world, circuit, enter, couple }) -> { circuit, r, apparatus }
//
// where `circuit` is an opaque, JSON-safe handle the backend uses to carry a
// run between steps (QASM3 text locally, an asset id over HTTP, a tiny object
// for the fake). The game stores it in the session and hands it back. `r` is
// one Bloch vector per holding, [<X>, <Y>, <Z>], and `apparatus` is the
// player's own qubit read the same way - null until it is in the circuit.
//
// TIME IS TURN-BASED. Nothing moves until the player does. One step of a
// world - t3 to t4, whether watched or held - is one step of the game clock.
// A day is `daySteps` of them (27: three worlds of nine), a week is `weekDays`
// days, and a position still open when the day's last step lands is closed
// where it stands. There are no timers anywhere.
//
// A turn is handle(S, token) -> { emissions, choices, summary }. Emissions are
// what a renderer shows:
//
//   { kind: 'text',   text, speaker? }
//   { kind: 'art',    art, text?, speaker? }              a named picture
//   { kind: 'traces', title, caption, n, holdings, priced, clean, upto,
//                     totalReadouts, target, interventionAt, foot, f }
//
// Each also carries `delay`, the milliseconds a client waits before showing it
// - see pacing.mjs - and a scene's carry `pace: true` besides.
//
// `choices` are the tokens the player may send next, with labels - a renderer
// makes buttons of them, or ignores them and lets the player type. Every
// button is just a token the player could have typed.

import {
  DEFAULT_PRICE, basePrice, quote, priceReturn, valueFactor, prospectus, overview,
  money, signedMoney, pct, fmt3, mulberry,
} from './pricing.mjs'
import * as story from './story.mjs'
import { withDelays } from './pacing.mjs'

export const DEFAULT_RULES = {
  steps: 10,            // readouts per world: t0..t9, so nine steps
  daySteps: 27,         // world steps in a game day - three worlds of nine
  weekDays: 7,
  startBudget: 1000,    // the day's allowance, never carried over
  budgetFloor: 500,
  budgetUp: 1.10,       // after a day that clears the quota
  budgetDown: 0.95,     // after any other day, idle ones included
  quota: 0.10,          // the share of the budget a day must clear to count
  probation: true,      // a new desk has a week to post a profit
  probationProfit: 0,   // the week's total must exceed this to pass
  weekBonus: 100,       // paid into the personal pot, only after probation
  upgradeCost: 10,      // one increment of regeneration, out of the day's budget
  regenSteps: 9,        // steps of watching that restore a spent qubit fully
  regenUnit: 0.25,      // each upgrade adds this much of the base rate
  nightSteps: 9,        // steps' worth of recovery the bell brings
  counterfactual: true, // also step the world uncoupled, for the ghost line
  price: DEFAULT_PRICE,
}

/** The scene `help` reads out when copy.yaml names none as `help_scene:`. */
export const HELP_SCENE = 'voice'

/** States a session can only be in because it was saved by an older build. */
const RETIRED_EXIT = new Set(['exit', 'confirm_exit'])

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const norm = (v) => Math.hypot(v[0], v[1], v[2])
const text = (t) => ({ kind: 'text', text: t })
const num = (s) => {
  const v = Number(String(s).replace(/[, gG]/g, ''))
  return Number.isFinite(v) ? v : null
}

export function createGame ({ copy, model, rules = {}, random = Math.random } = {}) {
  if (!copy) throw new Error('createGame: copy is required')
  if (!model) throw new Error('createGame: model is required')
  const R = { ...DEFAULT_RULES, ...rules, price: { ...DEFAULT_PRICE, ...(rules.price || {}) } }
  let C = copy
  void random

  // -------------------------------------------------------------------------
  // The session
  // -------------------------------------------------------------------------

  function newSession (seed = Date.now()) {
    // the player's qubit begins at Z = 1 with X and Y randomised, fully coherent
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    const v = [rnd() * 2 - 1, rnd() * 2 - 1, 1]
    const r = norm(v)
    return {
      version: 5,
      seed,
      direction: v.map((x) => x / r),
      coherence: 1,
      budget: R.startBudget,       // the day's allowance, the number that compounds
      balance: R.startBudget,      // what is left of it right now
      dayIndex: 0,
      dayStep: 0,                  // world steps taken today
      investedToday: 0,
      week: [],                    // this week's daily results
      history: [R.startBudget],
      probation: R.probation,
      attempts: 1,
      bonus: 0,                    // personal, cannot be staked
      rounds: 0,
      regenUnits: 0,
      seq: null, seqSeen: [], vars: {},      // scenes
      beatsSeen: [], beat: null, unlocked: [], // beats
      expect: 'boot',
      worlds: null,                // the three on offer
      world: null,                 // the one entered: {info, name, holdings, readouts, circuit, readings}
      pending: null,               // a stake being placed
      run: null,                   // an open position
    }
  }

  function summary (S) {
    const k = S.world ? S.world.readings.length - 1 : null
    return {
      expect: S.expect,
      day: S.dayIndex + 1,
      weekDay: story.weekDay(S),
      dayStep: S.dayStep,
      daySteps: R.daySteps,
      budget: Math.round(S.budget),
      balance: Math.round(S.balance),
      bonus: Math.round(S.bonus),
      coherence: +S.coherence.toFixed(3),
      probation: S.probation,
      attempts: S.attempts,
      rounds: S.rounds,
      regenUnits: S.regenUnits,
      world: S.world ? { id: S.world.info.id, name: S.world.name, n: S.world.info.n,
                         readout: k, readouts: S.world.readouts } : null,
      position: S.run ? { holding: C.holding(S.run.target, S.run.holdings), target: S.run.target,
                          stake: S.run.stake, investAt: S.run.investAt } : null,
      inScene: story.inSequence(S),
      pendingBeat: S.beat,
    }
  }

  // Every emission leaves through here, which is why the timing is stamped
  // here: one place decides it and both clients are handed the same answer,
  // rather than each inventing its own and a game read back in the browser
  // running to a different rhythm than the one played in the chat.
  const result = (S, emissions) =>
    ({ emissions: withDelays(C, emissions.flat().filter(Boolean)),
       choices: choices(S), summary: summary(S) })

  // -------------------------------------------------------------------------
  // Time, in steps
  // -------------------------------------------------------------------------

  const regenRate = (S) => (1 / R.regenSteps) * (1 + R.regenUnit * S.regenUnits)

  /** Restore the player's qubit by so many steps' worth. Returns what came back. */
  function regen (S, steps) {
    const before = S.coherence
    S.coherence = Math.min(1, S.coherence + regenRate(S) * steps)
    return S.coherence - before
  }

  const stepsToFull = (S) => (S.coherence >= 0.999 ? 0 : Math.ceil((1 - S.coherence) / regenRate(S)))
  const stepsLeft = (S) => Math.max(0, R.daySteps - S.dayStep)
  const bellDue = (S) => S.dayStep >= R.daySteps

  function describeSteps (n) {
    n = Math.max(0, Math.round(n))
    if (n >= R.daySteps) {
      const d = n / R.daySteps
      const s = Number.isInteger(d) ? String(d) : d.toFixed(1)
      return `${s} day${d === 1 ? '' : 's'}`
    }
    return `${n} step${n === 1 ? '' : 's'}`
  }

  /** One step of world time has passed. The qubit recovers only while it is watching. */
  function passStep (S, { holding = false } = {}) {
    S.dayStep += 1
    if (!holding) regen(S, 1)
  }

  // -------------------------------------------------------------------------
  // Days and weeks
  // -------------------------------------------------------------------------

  /**
   * Close the books and set tomorrow's allowance.
   *
   * A day counts only if something was staked and the result clears the quota;
   * anything else, an idle day included, costs 5%. The floor stops a bad run
   * spiralling. Every seventh day the week is totted up: on probation that is
   * the verdict, afterwards it is an ordinary week and may pay a bonus.
   */
  function closeDay (S) {
    const pl = S.balance - S.budget
    const quota = Math.round(S.budget * R.quota)
    const traded = S.investedToday > 0
    const good = traded && pl >= quota
    const next = Math.max(R.budgetFloor, Math.round(S.budget * (good ? R.budgetUp : R.budgetDown)))

    S.week.push(pl)
    let bonusPaid = 0
    let weekTotal = null
    let passed = null
    if (S.week.length >= R.weekDays) {
      weekTotal = S.week.reduce((a, b) => a + b, 0)
      passed = weekTotal > (S.probation ? R.probationProfit : 0)
      if (passed && !S.probation) { S.bonus += R.weekBonus; bonusPaid = R.weekBonus }
      S.week = []
    }

    const wasBudget = S.budget
    S.budget = next
    S.balance = next
    S.dayIndex += 1
    S.dayStep = 0
    S.investedToday = 0
    S.history.push(S.balance)

    let verdict = null
    if (S.probation && weekTotal !== null) {
      verdict = passed ? 'passed' : 'failed'
      if (passed) {
        S.probation = false
      } else {
        // wound back to the start - everything except the player's own qubit
        S.attempts = (S.attempts || 1) + 1
        S.budget = R.startBudget
        S.balance = R.startBudget
        S.week = []
        S.history = [R.startBudget]
      }
    }
    return { pl, traded, good, wasBudget, next, bonusPaid, weekTotal, verdict,
             attempt: S.attempts || 1, failures: (S.attempts || 1) - 1, day: S.dayIndex }
  }

  /** Which scene `help` narrates: copy.yaml's `help_scene`, else the default. */
  const helpScene = () => {
    const v = C.section('help_scene')
    return typeof v === 'string' && v ? v : HELP_SCENE
  }

  const beatCtx = (S) => ({ day: story.weekDay(S), budget: money(S.budget), attempt: S.attempts || 1 })

  function verdictScene (r) {
    if (r.verdict === 'passed') return 'probation_passed'
    const written = (id) => ((C.section(`sequences.${id}`) || []).length > 0)
    return r.failures > 1 && written('probation_failed_again') ? 'probation_failed_again' : 'probation_failed'
  }

  /** The bell: the books, the night, the week if it is over, and the new day's beat. */
  function endOfDay (S) {
    const r = closeDay(S)
    const out = [text(C.t('scenes.day_end', {
      day: r.day,
      pl: signedMoney(r.pl), pl_raw: r.pl,
      good: r.good, traded: r.traded, idle: !r.traded,
      was_budget: money(r.wasBudget), budget: money(r.next),
      change: r.good ? `+${Math.round((R.budgetUp - 1) * 100)}%` : `-${Math.round((1 - R.budgetDown) * 100)}%`,
      floored: r.next === R.budgetFloor,
      floor: money(R.budgetFloor),
    }))]
    const gained = regen(S, R.nightSteps)
    if (gained > 0.0005) {
      out.push(text(C.t('scenes.time_passed',
        { elapsed: 'A night', gained: `coherence +${gained.toFixed(3)}` })))
    }
    if (r.weekTotal !== null) {
      const ctx = {
        total: signedMoney(r.weekTotal), total_raw: r.weekTotal,
        paid: r.bonusPaid > 0, bonus: money(r.bonusPaid), pot: money(S.bonus),
        attempt: r.attempt, failures: r.failures, again: r.attempt > 1,
        budget: money(R.startBudget), coherence: S.coherence.toFixed(3),
      }
      if (r.verdict) {
        // On probation the week is a verdict, and a verdict is a scene. It takes
        // the floor; the new week's worlds are offered when it has finished,
        // and so is the new day's beat.
        out.push(...story.startSequence(C, S, verdictScene(r), ctx))
        if (story.inSequence(S)) { S.expect = 'sequence'; return out }
      } else {
        out.push(text(C.t('scenes.week_end', ctx)))
      }
    }
    out.push(...story.fireBeat(C, S, beatCtx(S)))
    return out
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  function sceneMain (S) {
    const recovering = S.coherence < 0.999
    const pl = S.balance - S.budget
    return [text(C.t('scenes.round', {
      round: S.rounds + 1,
      coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
      recovering,
      recovery: recovering ? describeSteps(stepsToFull(S)) : '',
      balance: money(S.balance), balance_raw: S.balance,
      budget: money(S.budget), budget_raw: S.budget,
      bonus: money(S.bonus), bonus_raw: S.bonus, has_bonus: S.bonus > 0,
      day: S.dayIndex + 1,
      day_left: describeSteps(stepsLeft(S)),
      pl: signedMoney(pl), pl_raw: pl,
      upgrades: S.regenUnits,
    }))]
  }

  /** Three worlds, named and tickered, distinct within the offer. */
  function offerWorlds (S) {
    const pool = S.allWorlds || []
    if (!pool.length) throw new Error('offerWorlds: the model offers no worlds')
    const rnd = mulberry((S.seed + S.rounds * 7919) | 0)
    const picks = []
    const used = new Set()
    while (picks.length < Math.min(3, pool.length)) {
      const i = Math.floor(rnd() * pool.length)
      if (used.has(i)) continue
      used.add(i)
      picks.push(pool[i])
    }
    const nameList = C.list('worlds')
    const names = []
    let guard = 0
    while (names.length < picks.length && nameList.length && guard++ < 1000) {
      const n = nameList[Math.floor(rnd() * nameList.length)]
      if (!names.includes(n)) names.push(n)
    }
    while (names.length < picks.length) names.push(`World ${names.length + 1}`)
    const tickers = C.list('holdings')
    const taken = new Set()
    S.worlds = picks.map((info, i) => {
      const holdings = []
      let g = 0
      while (holdings.length < info.n && taken.size < tickers.length && g++ < 10000) {
        const h = tickers[Math.floor(rnd() * tickers.length)]
        if (taken.has(h)) continue
        taken.add(h)
        holdings.push(h)
      }
      return { info, name: names[i], holdings }
    })
    S.expect = 'world'
    return [text(C.t('scenes.offer'))]
  }

  /** The numbers behind a chart. What is drawn is the quote, not the reading. */
  function tracesPanel (S, { upto, target = null, interventionAt = null, title, clean = null }) {
    const info = S.world.info
    const rows = S.world.readings.slice(0, upto + 1)
    const bases = Array.from({ length: info.n }, (_, q) => basePrice(info, q, R.price))
    const price = (row) => row.map((r, q) => quote(bases[q], r, R.price))
    return {
      kind: 'traces',
      n: info.n,
      holdings: S.world.holdings,
      world: S.world.name,
      upto,
      totalReadouts: S.world.readouts,
      target,
      interventionAt,
      // the value factor, not the raw reading: one number per holding per step,
      // which is the whole of what the quote above it is made of
      f: rows.map((row) => row.map((r) => valueFactor(r, R.price))),
      priced: rows.map(price),
      clean: clean ? clean.map(price) : null,
      title,
      foot: {
        left: C.moment(0),
        right: `${C.moment(S.world.readouts - 1)}  .  ${C.t('plots.traces_legend')}`,
      },
    }
  }

  function sceneInvestment (S) {
    const k = S.world.readings.length - 1
    S.expect = 'invest'
    return [{
      ...tracesPanel(S, { upto: k, title: C.t('plots.traces_title',
        { world: S.world.name, moment: C.moment(k), progress: k }) }),
      caption: C.t('scenes.investment', {
        world: S.world.name,
        moment: C.moment(k), progress: k, total: S.world.readouts - 1,
        coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
        balance: money(S.balance), balance_raw: S.balance,
        last_chance: k === S.world.readouts - 2,
      }),
    }]
  }

  /** The uncoupled continuation behind a held holding, priced with the rest. */
  function ghost (S) {
    const r = S.run
    if (!R.counterfactual || !r || !r.clean.length) return null
    return [...S.world.readings.slice(0, r.investAt + 1), ...r.clean]
  }

  function runningTitle (S, change) {
    const r = S.run
    return C.t('plots.traces_running', {
      world: S.world.name, target: r.target, holding: C.holding(r.target, r.holdings), change,
    })
  }

  /** The panel the moment a position opens: nothing has moved yet. */
  function openPanel (S) {
    const r = S.run
    return tracesPanel(S, { upto: r.investAt, target: r.target, interventionAt: r.investAt,
                            title: runningTitle(S, pct(0)) })
  }

  /** After a held step: the chart so far, captioned with the reading. */
  function readoutPanel (S) {
    const r = S.run
    const rows = S.world.readings
    const k = rows.length - 1
    const opened = rows[r.investAt][r.target]
    const now = rows[k][r.target]
    const f = valueFactor(now, R.price)
    const prev = valueFactor(rows[k - 1][r.target], R.price)
    // no longer inverted: the quote is exp(+sigma * f), so a rising value
    // factor is a rising price, and the arrow follows the physics as well as
    // the price for the first time
    const arrow = f > prev + 1e-6 ? '↗' : (f < prev - 1e-6 ? '↘' : '→')
    const mult = priceReturn(opened, now, R.price)
    const caption = C.t('scenes.readout', {
      world: S.world.name, target: r.target, holding: C.holding(r.target, r.holdings),
      moment: C.moment(k),
      value: money(quote(r.base, now, R.price)), value_raw: quote(r.base, now, R.price),
      reading: fmt3(f), reading_raw: f,
      change: pct(mult), change_raw: mult, arrow,
      pl: signedMoney(r.stake * mult), pl_raw: r.stake * mult,
    })
    return {
      ...tracesPanel(S, { upto: k, target: r.target, interventionAt: r.investAt,
                          clean: ghost(S), title: runningTitle(S, pct(mult)) }),
      caption,
    }
  }

  function sceneMarket (S) {
    S.expect = 'market'
    const recovering = S.coherence < 0.999
    return [text(C.t('scenes.marketplace', {
      recharge: describeSteps(R.regenSteps),
      unit_cost: money(R.upgradeCost),
      coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
      balance: money(S.balance), balance_raw: S.balance,
      budget: money(S.budget), budget_raw: S.budget,
      bonus: money(S.bonus), bonus_raw: S.bonus,
      units: S.regenUnits, upgrades: S.regenUnits,
      recovering,
      recovery: recovering ? describeSteps(stepsToFull(S)) : '',
    }))]
  }

  // -------------------------------------------------------------------------
  // A round: enter, watch, stake, hold, settle
  // -------------------------------------------------------------------------

  /** Enter a world: the first reading, and the sheet. */
  async function enterWorld (S, i) {
    const w = S.worlds[i - 1]
    const first = await model.step({ world: w.info.id, circuit: null, enter: null, couple: null })
    S.world = { info: w.info, name: w.name, holdings: w.holdings, readouts: R.steps,
                circuit: first.circuit, readings: [first.r] }
    const pr = prospectus(C, w.info)
    const entered = text(C.t('scenes.entered', {
      world: w.name,
      rows: overview(C, w.info, w.holdings, R.price)
        .map((h) => C.t('scenes.overview_row', h)).join('\n'),
      opportunities: pr.opportunities, complexity: pr.complexity,
      monopoly: pr.monopoly, volatility: pr.volatility,
      disconnected: w.info.connected === false,
    }))
    return [entered, ...sceneInvestment(S)]
  }

  /** Watch one more step, with nothing staked. */
  async function observe (S) {
    const next = await model.step({ world: S.world.info.id, circuit: S.world.circuit, enter: null, couple: null })
    S.world.circuit = next.circuit
    S.world.readings.push(next.r)
    passStep(S)
    const k = S.world.readings.length - 1
    const panel = sceneInvestment(S)
    if (bellDue(S)) return [...panel, ...endOfDay(S), ...endRound(S)]
    if (k >= S.world.readouts - 1) return [...panel, text(C.t('scenes.observed_all')), ...endRound(S)]
    return panel
  }

  /** The stake is placed and the position opens. The coupling begins next step. */
  function openPosition (S) {
    const k = S.world.readings.length - 1
    const { stake, target: q } = S.pending
    S.pending = null
    S.balance -= stake
    S.investedToday += 1
    S.run = {
      investAt: k, target: q, stake,
      entered: false,            // the apparatus joins the circuit on the first held step
      apparatus: null,           // what it reads as, after each held step
      holdings: S.world.holdings,
      base: basePrice(S.world.info, q, R.price),   // pinned, so the settle quotes what the open quoted
      clean: [],                 // the uncoupled continuation, for the ghost line
      cleanCircuit: S.world.circuit,
      forced: false,
    }
    S.expect = 'holding'
    return [
      text(C.t('scenes.staking', { stake: money(stake), target: q, holding: C.holding(q, S.world.holdings) })),
      text(C.t('scenes.position_open', { target: q, holding: C.holding(q, S.world.holdings),
                                         last: C.moment(S.world.readouts - 1), every: describeSteps(1) })),
      openPanel(S),
    ]
  }

  /**
   * Hold for one more step. The apparatus enters on the first of these and
   * couples from then on, every step, for as long as the position is held -
   * which is what spends it. The uncoupled world is stepped alongside, so the
   * chart can show where the price was going before the player touched it.
   */
  async function hold (S) {
    const r = S.run
    const id = S.world.info.id
    const enter = r.entered ? null : { direction: [...S.direction], coherence: S.coherence }
    const calls = [model.step({ world: id, circuit: S.world.circuit, enter, couple: r.target })]
    if (R.counterfactual) calls.push(model.step({ world: id, circuit: r.cleanCircuit, enter: null, couple: null }))
    const [a, b] = await Promise.all(calls)
    S.world.circuit = a.circuit
    S.world.readings.push(a.r)
    r.entered = true
    if (Array.isArray(a.apparatus)) r.apparatus = a.apparatus
    if (b) { r.cleanCircuit = b.circuit; r.clean.push(b.r) }
    passStep(S, { holding: true })

    const k = S.world.readings.length - 1
    const out = [readoutPanel(S)]
    if (k >= S.world.readouts - 1) return [...out, ...closeOut(S)]
    if (bellDue(S)) { r.forced = true; return [...out, ...closeOut(S)] }
    return out
  }

  /** Close where it stands, which is the only place a position ever closes. */
  function closePosition (S) {
    return closeOut(S)
  }

  /** A position has ended, one way or another. Settle, then whatever follows. */
  function closeOut (S) {
    const out = settle(S)
    const broke = S.balance < 1
    if (broke) out.push(text(C.t('scenes.broke')))
    // the bell closes the day; so does having nothing left to stake - the rest
    // of the day is forfeit and the desk sits it out
    if (bellDue(S) || broke) out.push(...endOfDay(S))
    out.push(...endRound(S))
    return out
  }

  /** The returns. The stake comes back scaled by the quote's move. */
  function settle (S) {
    const r = S.run
    const rows = S.world.readings
    const exitAt = rows.length - 1
    const opened = rows[r.investAt][r.target]
    const closed = rows[exitAt][r.target]
    // the move, said as the one number the payout is a function of
    const f0 = valueFactor(opened, R.price)
    const f1 = valueFactor(closed, R.price)
    const df = f1 - f0
    const mult = priceReturn(opened, closed, R.price)
    // whole G, so an apparently flat day does not settle a hair under budget
    const returned = Math.round(r.stake * (1 + mult))
    const profit = returned - r.stake
    S.balance = Math.max(0, S.balance + returned)

    const before = S.coherence
    if (Array.isArray(r.apparatus)) {
      const fr = norm(r.apparatus)
      if (fr > 1e-9) S.direction = r.apparatus.map((x) => x / fr)
      S.coherence = clamp(fr, 0, 1)
    }

    const out = [text(C.t('scenes.returns', {
      target: r.target, holding: C.holding(r.target, r.holdings),
      opened_at: money(quote(r.base, opened, R.price)), closed_at: money(quote(r.base, closed, R.price)),
      opened_reading: f0.toFixed(4), closed_reading: f1.toFixed(4),
      exit: C.moment(exitAt),
      change: `${df >= 0 ? '+' : ''}${df.toFixed(4)}`, change_raw: df,
      multiplier: `${mult >= 0 ? '+' : ''}${mult.toFixed(4)}`, multiplier_raw: mult,
      stake: money(r.stake), stake_raw: r.stake,
      returned: money(returned), returned_raw: returned,
      profit: signedMoney(profit), profit_raw: profit,
      outcome: profit >= 0 ? 'profit' : 'loss',
      balance: money(S.balance), balance_raw: S.balance,
      flat: Math.abs(df) < 1e-6,
      forced: Boolean(r.forced),
      coherence: S.coherence.toFixed(3), was_coherence: before.toFixed(3),
      drained: S.coherence < before - 0.3,
    }))]
    S.run = null
    return out
  }

  /** Out of the world; the next round is offered unless a scene has the floor. */
  function endRound (S) {
    S.rounds += 1
    S.world = null
    S.pending = null
    if (story.inSequence(S)) return []
    return [...sceneMain(S), ...offerWorlds(S)]
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /** The world list is not saved with a session; fetch it when it is missing. */
  async function hydrate (S) {
    if (!S.allWorlds) S.allWorlds = await model.worlds()
    // A game saved while the exit question still existed. Nothing was taken -
    // the stake leaves the balance only when the position opens - so it picks
    // up at the invest prompt, with the world and its readings as they were.
    if (RETIRED_EXIT.has(S.expect)) { S.pending = null; S.expect = 'invest' }
    return S
  }

  /**
   * The opening, or the game.
   *
   * A first sitting plays the opening scenes in the order copy.yaml lists them,
   * each once; a scene that stops for the player returns here, and the next
   * unseen one begins when it ends. When none are left the game starts: the
   * standing, three worlds, and any beat due today.
   */
  async function start (S) {
    await hydrate(S)
    const out = []
    for (const id of C.list('opening')) {
      if ((S.seqSeen || []).includes(id)) continue
      out.push(...story.startSequence(C, S, id))
      if (story.inSequence(S)) { S.expect = 'sequence'; return result(S, out) }
      S.seqSeen = [...new Set([...(S.seqSeen || []), id])]
    }
    if (S.world) {
      // a scene ended with a world still open - nothing to offer, carry on
      S.expect = S.run ? 'holding' : 'invest'
      return result(S, out)
    }
    // The opening stands in place of the welcome: someone who was walked to
    // their desk is not then read the brochure. Skipping the opening skips it too.
    const walkedIn = C.list('opening').some((id) => (S.seqSeen || []).includes(id))
    if (!walkedIn) {
      out.push(text(C.t('scenes.welcome', {
        worlds: S.allWorlds.length, skipped: 0, recharge: describeSteps(R.regenSteps),
      })))
    }
    out.push(...sceneMain(S), ...offerWorlds(S), ...story.fireBeat(C, S, beatCtx(S)))
    return result(S, out)
  }

  /** Handle one token. */
  async function handle (S, raw) {
    await hydrate(S)
    const input = String(raw ?? '')
    const cmd = input.trim().toLowerCase()

    // A running scene has the floor. It answers first, and a command it does
    // not recognise gets a nudge rather than reaching the game.
    if (story.inSequence(S)) {
      if (cmd === 'skip' || cmd === '/skip') {
        story.endSequence(S)
        S.seqSeen = [...new Set([...(S.seqSeen || []), ...C.list('opening')])]
        return start(S)
      }
      const said = story.answerSequence(C, S, input)
      if (said) {
        if (!story.inSequence(S)) {
          const r = await start(S)
          return result(S, [...said, ...r.emissions])
        }
        return result(S, said)
      }
      return result(S, [text(C.t('prompts.scene_waiting'))])
    }

    if (S.expect === 'boot' || S.expect === 'sequence') return start(S)

    // A pending beat is answered before anything else looks at the command, and
    // does not touch `expect` - so it can be answered mid-position, and a
    // command that is not one of its choices falls through untouched.
    const answered = story.answerBeat(C, S, cmd)
    if (answered) return result(S, answered)

    if (!cmd) return result(S, [text(C.t('prompts.say_something'))])
    if (['help', '?', '/help'].includes(cmd)) {
      return result(S, [...story.narrate(C, S, helpScene()), text(C.t('prompts.help'))])
    }
    if (['state', 'status', '/status', '/state'].includes(cmd)) return result(S, sceneMain(S))

    switch (S.expect) {
      case 'world': {
        if (cmd === 'm') return result(S, sceneMarket(S))
        const i = num(cmd)
        if (!S.worlds || !Number.isInteger(i) || i < 1 || i > S.worlds.length) {
          return result(S, [text(C.t('prompts.unknown', { options: '**1**, **2** or **3**, or **m**' }))])
        }
        return result(S, await enterWorld(S, i))
      }

      case 'invest': {
        const k = S.world.readings.length - 1
        // leaving is free only before anything has been watched
        if (cmd === 'l' && k === 0) {
          S.world = null
          return result(S, [text(C.t('scenes.left')), ...sceneMain(S), ...offerWorlds(S)])
        }
        if (cmd === 'o' || cmd === 'w') return result(S, await observe(S))
        if (cmd !== 'i') {
          return result(S, [text(C.t('prompts.unknown', {
            options: '**i** to invest · **o** to observe' + (k === 0 ? ' · **l** to leave' : ''),
          }))])
        }
        if (S.balance < 1) return result(S, [text(C.t('scenes.nothing_to_stake'))])
        S.expect = 'stake'
        return result(S, [text(C.t('scenes.ask_stake', { balance: Math.floor(S.balance) }))])
      }

      case 'stake': {
        const v = num(cmd)
        if (v === null || v < 1) {
          S.expect = 'invest'
          return result(S, [text(C.t('prompts.unknown', { options: '**i** to try again or **o** to observe' }))])
        }
        S.pending = { stake: clamp(Math.round(v), 1, Math.floor(S.balance)) }
        S.expect = 'target'
        return result(S, [text(C.t('scenes.ask_target', { last: S.world.info.n - 1 }))])
      }

      case 'target': {
        const n = S.world.info.n
        const q = num(cmd)
        if (q === null || !Number.isInteger(q) || q < 0 || q >= n) {
          return result(S, [text(C.t('scenes.ask_target', { last: n - 1 }))])
        }
        S.pending.target = q
        return result(S, openPosition(S))
      }

      case 'holding': {
        if (cmd === 'h' || cmd === 'hold') return result(S, await hold(S))
        if (cmd === 'c' || cmd === 'close') return result(S, closePosition(S))
        return result(S, [text(C.t('prompts.unknown', { options: '**h** to hold · **c** to close' }))])
      }

      case 'market': {
        if (cmd === 'l') return result(S, [...sceneMain(S), ...offerWorlds(S)])
        if (cmd === 'b') { S.expect = 'buy'; return result(S, [text(C.t('scenes.ask_units'))]) }
        return result(S, [text(C.t('prompts.unknown', { options: '**b** or **l**' }))])
      }

      case 'buy': {
        const k = num(cmd)
        if (k === null || k < 1) return result(S, sceneMarket(S))
        const want = Math.floor(k)
        const afford = Math.min(want, Math.floor(S.balance / R.upgradeCost))
        if (afford < 1) {
          return result(S, [text(C.t('scenes.cannot_afford',
            { cost: money(R.upgradeCost), balance: money(S.balance) })), ...sceneMarket(S)])
        }
        S.balance -= afford * R.upgradeCost
        S.regenUnits += afford
        return result(S, [text(C.t('scenes.upgraded', {
          bought: afford, spent: money(afford * R.upgradeCost),
          upgrades: S.regenUnits, recovery: describeSteps(Math.ceil(1 / regenRate(S))),
        })), ...sceneMarket(S)])
      }

      default:
        return result(S, [text(C.t('prompts.nothing_to_decide'))])
    }
  }

  /** What the player may send next. Every entry is a token they could type. */
  /**
   * What the player may send next.
   *
   * Each entry says where it came from. A renderer that shows them all in one
   * undifferentiated row leaves the player unable to tell why answering a
   * conversation was what their keystroke did: a beat's choices sit alongside
   * the game's, and a beat token would shadow a game command of the same name.
   *
   * This is read in error paths, so it must not be the thing that throws. Every
   * case guards its own reach into the session.
   */
  function choices (S) {
    const scene = story.sequenceChoices(C, S)
    if (scene.length) return scene.map((c) => ({ ...c, kind: 'scene' }))
    const out = story.beatChoices(C, S).map((c) => ({ ...c, kind: 'beat' }))
    const push = (token, label) => out.push({ token, label, kind: 'game' })
    // `choices` is read before a resumed game has taken a turn, so it answers
    // for a retired state too rather than offering nothing; `hydrate` writes
    // the change into the session on that turn.
    switch (RETIRED_EXIT.has(S.expect) ? 'invest' : S.expect) {
      case 'world':
        ;(S.worlds || []).forEach((w, i) =>
          push(`${i + 1}`, C.t('buttons.world', { index: i + 1, world: w.name, opportunities: w.info.n })))
        push('m', C.t('buttons.marketplace'))
        break
      case 'invest':
        push('i', C.t('buttons.invest'))
        push('o', C.t('buttons.observe'))
        if (S.world && S.world.readings.length - 1 === 0) push('l', C.t('buttons.leave'))
        break
      case 'stake': {
        const m = Math.floor(S.balance)
        ;[...new Set([100, 250, 500, Math.floor(m / 2), m])]
          .filter((v) => v >= 1 && v <= m).sort((a, b) => a - b)
          .forEach((v) => push(`${v}`, C.t(v === m ? 'buttons.all_stake' : 'buttons.stake',
            { amount: `${v.toLocaleString('en-GB')}G` })))
        break
      }
      case 'target':
        for (let q = 0; q < (S.world?.info?.n || 0); q++) {
          push(`${q}`, C.t('buttons.qubit', { index: q, holding: C.holding(q, S.world.holdings) }))
        }
        break
      case 'holding':
        push('h', C.t('buttons.hold'))
        push('c', C.t('buttons.close'))
        push('state', C.t('buttons.status'))
        break
      case 'market':
        push('b', C.t('buttons.buy'))
        push('l', C.t('buttons.leave'))
        break
      case 'buy':
        for (const v of ['1', '2', '5', '10']) push(v, v)
        break
      default:
        break
    }
    return out
  }

  return {
    rules: R,
    newSession, start, handle, choices, summary, hydrate,
    setCopy (c) { C = c },
    get copy () { return C },
    // the pieces, for tests and other hosts
    closeDay, endOfDay, regen, regenRate, describeSteps, stepsLeft, bellDue, sceneMain, offerWorlds,
  }
}
