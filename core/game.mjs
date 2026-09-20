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
// world - t3 to t4, whether watched or held - is one step of the game clock,
// and so is an hour the player spends waiting, which moves no world at all.
// A day is `daySteps` of them (27: three worlds of nine), a week is `weekDays`
// days, and a position still open when the day's last step lands is closed
// where it stands. There are no timers anywhere.
//
// A turn is handle(S, token) -> { emissions, choices, summary }. Emissions are
// what a renderer shows:
//
//   { kind: 'text',   text, speaker?, title?, voice? }
//   { kind: 'art',    art, text?, speaker?, title?, voice? }   a named picture
//   { kind: 'traces', title, caption, n, holdings, priced, clean, upto,
//                     totalReadouts, target, interventionAt, foot, f }
//
// Each also carries `delay`, the milliseconds a client waits before showing it
// - see pacing.mjs - and a scene's carry `pace: true` besides.
//
// `title` is the heading over a line - a speaker's name is one, and so is
// `Day 3` or `Report: Liked Rounds`. `voice: 'player'` marks a line spoken by
// or about the player rather than at them. Both exist for renderers that draw
// the difference; one that does not is free to ignore them.
//
// `choices` are the tokens the player may send next, with labels - a renderer
// makes buttons of them, or ignores them and lets the player type. Every
// button is just a token the player could have typed.

import {
  DEFAULT_PRICE, basePrice, quote, priceReturn, valueFactor, prospectus, overview,
  money, signedMoney, pct, mulberry,
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
  probationShare: 0.5,  // of every budget the week is handed, the share it must clear
  weekBonus: 100,       // paid into the personal pot, only after probation
  upgradeCost: 10,      // one increment of regeneration, out of the day's budget
  regenSteps: 9,        // steps of watching that restore a spent qubit fully
  upgradeRegen: 1,      // steps' worth of recovery one purchase brings, at once
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
/**
 * A line, and the heading over it when it has one.
 *
 * The game's own blocks - the day, the bell, a report, the returns - are
 * headed rather than spoken, and the heading is the writer's: it is a
 * `_title` key beside the body in copy.yaml, rendered with the same values.
 * A renderer draws it however it likes, or not at all; a heading nobody asked
 * for is simply absent from the emission.
 */
const text = (t, title = null) => ({ kind: 'text', text: t, ...(title ? { title } : {}) })
/**
 * The same, voiced as the player's own.
 *
 * A scene node says this for itself with `voice: player` in copy.yaml; the
 * game's own lines have no node to say it on, so the few that are the player's
 * rather than the desk's are marked here.
 */
const playerText = (t) => ({ ...text(t), voice: 'player' })
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

  /**
   * One of the game's own blocks: its body and the heading over it.
   *
   * The heading lives beside the body in copy.yaml as `<key>_title` and is
   * rendered with the same values, so `Report: {world}` names the world it
   * heads. A writer changing either finds both in one place.
   */
  const titled = (key, ctx = {}) =>
    text(C.t(`scenes.${key}`, ctx), C.t(`scenes.${key}_title`, ctx))

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
      weekBudgets: [],             // and the budget each of those days was played on
      history: [R.startBudget],
      probation: R.probation,
      attempts: 1,
      bonus: 0,                    // personal, cannot be staked
      rounds: 0,
      upgradesToday: 0,            // purchases made today; the day's budget bought them
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
      upgradesToday: S.upgradesToday,
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

  /**
   * How much of the qubit one step brings back.
   *
   * Flat, and nothing buys a better one: the workshop sells recovery by the
   * hour rather than selling a faster clock, so a spent terminal always takes
   * `regenSteps` hours to come back and the only question is who spends them.
   */
  const regenRate = () => 1 / R.regenSteps

  /** Restore the player's qubit by so many steps' worth. Returns what came back. */
  function regen (S, steps) {
    const before = S.coherence
    S.coherence = Math.min(1, S.coherence + regenRate() * steps)
    return S.coherence - before
  }

  const stepsToFull = (S) => (S.coherence >= 0.999 ? 0 : Math.ceil((1 - S.coherence) / regenRate()))
  const stepsLeft = (S) => Math.max(0, R.daySteps - S.dayStep)
  const bellDue = (S) => S.dayStep >= R.daySteps

  /**
   * Steps, said as steps however many there are.
   *
   * What a step is CALLED is a writer's word, not the engine's - copy.yaml
   * names it under `vocabulary.step`, beside the holding and the moment. The
   * engine counts them and says nothing about what they are.
   */
  const inSteps = (n) => C.t('vocabulary.step', { n: Math.max(0, Math.round(n)) })

  /** Steps, said as days once there are enough of them to be worth it. */
  function describeSteps (n) {
    n = Math.max(0, Math.round(n))
    if (n >= R.daySteps) {
      const d = n / R.daySteps
      const s = Number.isInteger(d) ? String(d) : d.toFixed(1)
      return `${s} day${d === 1 ? '' : 's'}`
    }
    return inSteps(n)
  }

  /** One step of world time has passed. The qubit recovers only while it is watching. */
  function passStep (S, { holding = false } = {}) {
    S.dayStep += 1
    if (!holding) regen(S, 1)
  }

  /**
   * One step spent on nothing at all.
   *
   * No world is stepped, which is the whole of what separates this from
   * watching one: a world moves when the player moves it, and sitting back
   * does not move it. What it buys is the step of recovery watching would have
   * brought, at the same price in the day - so a spent terminal can be cleaned
   * up without a world's readouts being burnt through to do it, and a bad
   * trade is something a desk can sit out rather than only trade through.
   *
   * It is the player's own hour and reads as theirs, like the night does.
   */
  function waitStep (S) {
    const before = S.coherence
    passStep(S)
    const gained = S.coherence - before
    const recovering = S.coherence < 0.999
    const out = [playerText(C.t('scenes.waited', {
      elapsed: inSteps(1),
      gained: gained.toFixed(3), gained_raw: gained, recovered: gained > 0.0005,
      coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
      recovering, recovery: recovering ? describeSteps(stepsToFull(S)) : '',
      steps_left: inSteps(stepsLeft(S)), day_left: describeSteps(stepsLeft(S)),
    }))]
    // an hour is an hour: the last one of the day rings the bell, whether it
    // was spent watching, holding or sitting still
    if (bellDue(S)) return [...out, ...endOfDay(S), ...endRound(S)]
    return out
  }

  // -------------------------------------------------------------------------
  // Days and weeks
  // -------------------------------------------------------------------------

  /** Days of the week still to play, today included. */
  const daysLeft = (S) => Math.max(0, R.weekDays - ((S.weekBudgets || []).length))

  /** What the week has banked. Today is not in it - it has not closed yet. */
  const weekMade = (S) => (S.week || []).reduce((a, b) => a + b, 0)

  /**
   * What the week has to clear: a share of every budget it is handed.
   *
   * Only closed days have a budget on record; the ones still to come are
   * reckoned at today's, so the bar moves as the allowance does. Clear a day
   * and tomorrow's budget goes up - and so does what the week wants of you.
   */
  function weekTarget (S) {
    const granted = (S.weekBudgets || []).reduce((a, b) => a + b, 0)
    return (granted + S.budget * daysLeft(S)) * R.probationShare
  }

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
    // the budget this day was played on, kept so the week's target is the sum
    // of what was actually handed over rather than seven times today's
    S.weekBudgets = [...(S.weekBudgets || []), S.budget]
    let bonusPaid = 0
    let weekTotal = null
    let passed = null
    let target = null
    if (S.weekBudgets.length >= R.weekDays) {
      weekTotal = S.week.reduce((a, b) => a + b, 0)
      // on probation the bar is the week's own; afterwards any profit is a week
      target = weekTarget(S)
      passed = S.probation ? weekTotal >= target : weekTotal > 0
      if (passed && !S.probation) { S.bonus += R.weekBonus; bonusPaid = R.weekBonus }
      S.week = []
      S.weekBudgets = []
    }

    const wasBudget = S.budget
    S.budget = next
    S.balance = next
    S.dayIndex += 1
    S.dayStep = 0
    S.investedToday = 0
    S.upgradesToday = 0          // the day's budget bought them; the day is over
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
        S.weekBudgets = []
        S.history = [R.startBudget]
      }
    }
    return { pl, traded, good, wasBudget, next, bonusPaid, weekTotal, verdict, target,
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
    const out = [titled('day_end', {
      day: r.day,
      pl: signedMoney(r.pl), pl_raw: r.pl,
      good: r.good, traded: r.traded, idle: !r.traded,
      was_budget: money(r.wasBudget), budget: money(r.next),
      change: r.good ? `+${Math.round((R.budgetUp - 1) * 100)}%` : `-${Math.round((1 - R.budgetDown) * 100)}%`,
      floored: r.next === R.budgetFloor,
      floor: money(R.budgetFloor),
    })]
    const gained = regen(S, R.nightSteps)
    // said whether or not anything came back: a terminal already clean still
    // spends the night doing this, and going home is what ends a day
    // the player's own evening rather than the desk's - so it is voiced as
    // theirs, like the scripted lines that narrate what they did
    out.push(playerText(C.t('scenes.night', {
      elapsed: 'A night', gained: `coherence +${gained.toFixed(3)}`,
      recovered: gained > 0.0005,
    })))
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
        out.push(titled('week_end', ctx))
      }
    }
    // the day is established before anything that happens in it, the day's
    // own setpiece included. The worlds come after both, from the endRound
    // that follows every bell - and a setpiece that asks something holds them
    // back until it has its answer. See offerOrHold.
    out.push(...sceneMain(S))
    out.push(...story.fireBeat(C, S, beatCtx(S)))
    return out
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  /**
   * The day, established.
   *
   * It opens a day and is not said again between that day's rounds - the
   * worlds are offered on their own after the first. Which is why the week's
   * arithmetic is written out here in full: this is the one place it is said.
   *
   * The middle line is a key of its own because there are two of them - a week
   * of probation counts down to a target, an ordinary week counts down to a
   * bonus - and a writer should be able to see them side by side rather than
   * inside a conditional.
   */
  /**
   * Where the player stands, as both messages that say it read it.
   *
   * The middle line - the week's arithmetic - is rendered here rather than
   * inside either message, because the day block and `status` say the same
   * sentence and a writer should only have to write it once.
   */
  function standing (S) {
    const recovering = S.coherence < 0.999
    const pl = S.balance - S.budget
    const made = weekMade(S)
    const target = weekTarget(S)
    const short = target - made
    const week = {
      days_left: daysLeft(S),
      target: money(target), target_raw: target,
      target_left: money(Math.max(0, short)), target_left_raw: Math.max(0, short),
      ahead: short <= 0,
      surplus: money(Math.max(0, -short)), surplus_raw: Math.max(0, -short),
      made: money(made), made_raw: made,
      week_bonus: money(R.weekBonus), week_bonus_raw: R.weekBonus,
      pot: money(S.bonus), pot_raw: S.bonus, has_pot: S.bonus > 0,
    }
    return {
      ...week,
      week_line: C.t(S.probation ? 'scenes.day_probation' : 'scenes.day_week', week),
      probation: S.probation,
      round: S.rounds + 1,
      coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
      recovering,
      recovery: recovering ? describeSteps(stepsToFull(S)) : '',
      balance: money(S.balance), balance_raw: S.balance,
      budget: money(S.budget), budget_raw: S.budget,
      bonus: money(S.bonus), bonus_raw: S.bonus, has_bonus: S.bonus > 0,
      day: S.dayIndex + 1,
      day_left: describeSteps(stepsLeft(S)),
      steps_left: inSteps(stepsLeft(S)),
      pl: signedMoney(pl), pl_raw: pl,
      upgrades: S.upgradesToday,
    }
  }

  function sceneMain (S) {
    return [titled('day', standing(S))]
  }

  /**
   * The same standing, asked for again mid-day.
   *
   * A day block is written once and then stays written, so by the third round
   * the two numbers that move - what is left of the day and what is left of
   * the budget - are no longer what it says. This is where they are read.
   */
  function sceneStatus (S) {
    return [titled('status', standing(S))]
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
    // the player turning to the terminal, not the terminal announcing itself
    return [playerText(C.t('scenes.offer'))]
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

  /**
   * The chart, and nothing else.
   *
   * It carries no caption on purpose. The sheet already says which world this
   * is, how old it is, how big, and what the position is doing; a line under
   * it saying the same again is a second, worse copy of the picture. The
   * numbers are still on the emission for a renderer that wants them.
   */
  function sceneInvestment (S) {
    const k = S.world.readings.length - 1
    S.expect = 'invest'
    return [tracesPanel(S, { upto: k, title: C.t('plots.traces_title',
      { world: S.world.name, moment: C.moment(k), progress: k }) })]
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

  /** After a held step: the chart so far, and, as above, no words under it. */
  function readoutPanel (S) {
    const r = S.run
    const rows = S.world.readings
    const k = rows.length - 1
    const opened = rows[r.investAt][r.target]
    const now = rows[k][r.target]
    const mult = priceReturn(opened, now, R.price)
    return tracesPanel(S, { upto: k, target: r.target, interventionAt: r.investAt,
                            clean: ghost(S), title: runningTitle(S, pct(mult)) })
  }

  function sceneMarket (S) {
    S.expect = 'market'
    const recovering = S.coherence < 0.999
    return [titled('marketplace', {
      recharge: describeSteps(R.regenSteps),
      unit_cost: money(R.upgradeCost),
      coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
      balance: money(S.balance), balance_raw: S.balance,
      budget: money(S.budget), budget_raw: S.budget,
      bonus: money(S.bonus), bonus_raw: S.bonus,
      units: S.upgradesToday, upgrades: S.upgradesToday,
      recovering,
      recovery: recovering ? describeSteps(stepsToFull(S)) : '',
    })]
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
    const entered = titled('entered', {
      world: w.name,
      rows: overview(C, w.info, w.holdings, R.price)
        .map((h) => C.t('scenes.overview_row', h)).join('\n'),
      opportunities: pr.opportunities, complexity: pr.complexity,
      monopoly: pr.monopoly, volatility: pr.volatility,
      disconnected: w.info.connected === false,
    })
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
    // the quote it was taken at, from the pinned base - the same number the
    // settle will say it opened at
    const at = quote(S.run.base, S.world.readings[k][q], R.price)
    return [
      text(C.t('scenes.position_open', {
        target: q, holding: C.holding(q, S.world.holdings),
        opened_at: money(at), opened_at_raw: at,
        stake: money(stake), stake_raw: stake,
        last: C.moment(S.world.readouts - 1), every: describeSteps(1),
      })),
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
    if (broke) out.push(titled('broke'))
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

    const out = [titled('returns', {
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
    })]
    S.run = null
    return out
  }

  /**
   * The day's worlds, offered - unless somebody is still talking.
   *
   * A setpiece fires as a day opens and the worlds would go out in the same
   * breath, so a setpiece that asks something puts its two choices in the same
   * row as the three worlds and nothing on screen says which question a
   * keystroke is answering. It holds the offer instead: `beat` is the state of
   * waiting on one, and answering it is what opens the market.
   *
   * A setpiece with nothing to answer holds nothing. It is a line, it has been
   * said, and the day carries on under it.
   */
  function offerOrHold (S) {
    if (story.inSequence(S)) return []
    if (S.beat) { S.expect = 'beat'; return [] }
    return offerWorlds(S)
  }

  /** Out of the world; the next round is offered unless something has the floor. */
  function endRound (S) {
    S.rounds += 1
    S.world = null
    S.pending = null
    return offerOrHold(S)
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /** The world list is not saved with a session; fetch it when it is missing. */
  async function hydrate (S) {
    if (!S.allWorlds) S.allWorlds = await model.worlds()
    // The probation arithmetic, for any scene that quotes it. It lives on the
    // session rather than being handed to a scene when it starts because
    // `help` reads the tutorial back OUTSIDE a running scene, and a line that
    // rendered in the opening has to render there too.
    S.vars = {
      ...(S.vars || {}),
      daily_budget: money(R.startBudget),
      week_target: money(R.startBudget * R.weekDays * R.probationShare),
    }
    // A game saved before the week's budgets were kept. The days already
    // closed are reckoned at today's, which is what the target does with the
    // days still to come.
    if (!Array.isArray(S.weekBudgets)) S.weekBudgets = (S.week || []).map(() => S.budget)
    // A game saved while the exit question still existed. Nothing was taken -
    // the stake leaves the balance only when the position opens - so it picks
    // up at the invest prompt, with the world and its readings as they were.
    if (RETIRED_EXIT.has(S.expect)) { S.pending = null; S.expect = 'invest' }
    // A game saved when an upgrade bought a permanently faster clean-up rather
    // than an hour of recovery outright. There is no such thing to carry over:
    // the rate is the rate, and what is counted now is the day's purchases.
    if (S.upgradesToday === undefined) { S.upgradesToday = 0; delete S.regenUnits }
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
      out.push(titled('welcome', {
        worlds: S.allWorlds.length, skipped: 0, recharge: describeSteps(R.regenSteps),
      }))
    }
    // the day, then whatever the day opens on, and only then the worlds - a
    // setpiece that asks something is answered before the market is
    out.push(...sceneMain(S), ...story.fireBeat(C, S, beatCtx(S)), ...offerOrHold(S))
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
        // A scene stopped on an `ask` cannot be skipped past. The answer is
        // the player's own and the game carries it from there, so there is
        // nothing to skip it with - and the word itself must not land in the
        // variable, which is why this is caught here rather than below.
        if (story.awaitingAsk(C, S)) return result(S, [text(C.t('prompts.ask_first'))])
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
    if (answered) {
      // one fired as the day opened is holding the day's worlds back; hearing
      // it out is what offers them
      if (S.expect === 'beat') return result(S, [...answered, ...offerWorlds(S)])
      return result(S, answered)
    }

    if (!cmd) return result(S, [text(C.t('prompts.say_something'))])
    if (['help', '?', '/help'].includes(cmd)) {
      return result(S, [...story.narrate(C, S, helpScene()),
                        text(C.t('prompts.help'), C.t('prompts.help_title'))])
    }
    if (['state', 'status', '/status', '/state'].includes(cmd)) return result(S, sceneStatus(S))
    // An hour spent on nothing, from wherever the player is standing. It is the
    // only way the clock moves without a world moving with it, and the only way
    // a spent terminal cleans up that does not cost a world's readouts.
    if (['wait', '/wait'].includes(cmd)) {
      // Not with a position open. The coupling is what spends the terminal and
      // it runs for exactly as long as the position does, so an hour of it
      // cannot be sat out - and one that regenerated would undo the trade's
      // whole cost for the price of a keystroke.
      if (S.expect === 'holding') return result(S, [text(C.t('scenes.cannot_wait'))])
      return result(S, waitStep(S))
    }

    switch (S.expect) {
      case 'world': {
        if (cmd === 'm') return result(S, sceneMarket(S))
        const i = num(cmd)
        if (!S.worlds || !Number.isInteger(i) || i < 1 || i > S.worlds.length) {
          return result(S, [text(C.t('prompts.unknown', {
            options: '**1**, **2** or **3** · **wait** · **m**',
          }))])
        }
        return result(S, await enterWorld(S, i))
      }

      case 'invest': {
        // Leaving is free wherever it is done. The hours already spent
        // watching are spent either way, and nothing is committed until a
        // stake is - so walking out of a world that has not moved the way it
        // looked like it would is a move, not a forfeit.
        if (cmd === 'l') {
          S.world = null
          return result(S, [text(C.t('scenes.left')), ...offerWorlds(S)])
        }
        if (cmd === 'o' || cmd === 'w') return result(S, await observe(S))
        if (cmd !== 'i') {
          return result(S, [text(C.t('prompts.unknown', {
            options: '**i** to invest · **o** to observe · **l** to leave',
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

      case 'beat':
        // the setpiece has the floor until it is answered; `wait`, `help` and
        // `status` have already been past, and they are the whole of what else
        // there is to do
        if (!S.beat) return result(S, offerWorlds(S))     // saved mid-wait, the beat since gone
        return result(S, [text(C.t('prompts.beat_waiting'))])

      case 'market': {
        if (cmd === 'l') return result(S, offerWorlds(S))
        if (cmd === 'b') { S.expect = 'buy'; return result(S, [text(C.t('scenes.ask_units'))]) }
        return result(S, [text(C.t('prompts.unknown', { options: '**b** or **l**' }))])
      }

      case 'buy': {
        const k = num(cmd)
        if (k === null || k < 1) return result(S, sceneMarket(S))
        const want = Math.floor(k)
        // Three things limit a purchase and the smallest of them wins: what
        // was asked for, what the day's balance covers, and what the terminal
        // still has room to take. The shop will take money for very little,
        // but not for nothing at all - an hour sold onto a full meter is an
        // hour that goes nowhere, and it is not charged for.
        const room = Math.ceil(stepsToFull(S) / R.upgradeRegen)
        if (room < 1) return result(S, [text(C.t('scenes.already_clean')), ...sceneMarket(S)])
        const afford = Math.floor(S.balance / R.upgradeCost)
        if (afford < 1) {
          return result(S, [text(C.t('scenes.cannot_afford',
            { cost: money(R.upgradeCost), balance: money(S.balance) })), ...sceneMarket(S)])
        }
        const bought = Math.min(want, afford, room)
        const spent = bought * R.upgradeCost
        S.balance -= spent
        S.upgradesToday += bought
        // the whole of what an upgrade is: the hour, handed over on the spot
        const gained = regen(S, bought * R.upgradeRegen)
        const recovering = S.coherence < 0.999
        return result(S, [text(C.t('scenes.upgraded', {
          bought, wanted: want, capped: bought < want,
          spent: money(spent), spent_raw: spent,
          upgrades: S.upgradesToday,
          gained: gained.toFixed(3), gained_raw: gained,
          coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
          recovering, recovery: recovering ? describeSteps(stepsToFull(S)) : '',
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
        push('wait', C.t('buttons.wait'))
        push('m', C.t('buttons.marketplace'))
        break
      case 'invest':
        push('i', C.t('buttons.invest'))
        push('o', C.t('buttons.observe'))
        push('l', C.t('buttons.leave'))
        break
      case 'stake': {
        const m = Math.floor(S.balance)
        ;[...new Set([100, 250, 500, Math.floor(m / 2), m])]
          .filter((v) => v >= 1 && v <= m).sort((a, b) => a - b)
          .forEach((v) => push(`${v}`, C.t(v === m ? 'buttons.all_stake' : 'buttons.stake',
            { amount: money(v) })))
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
      case 'beat':
        // nothing of the game's own: the setpiece's choices, collected above,
        // are the whole of what may be answered
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
