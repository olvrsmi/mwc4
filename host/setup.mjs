// setup.mjs - the wiring every renderer needs, in one place.
//
// core/ holds the rules and knows nothing about the world outside itself. A
// renderer has to put the pieces together before it can ask the game anything:
// read the settings, read the words, pick a physics backend, open the store.
// That assembly is identical whoever is rendering, so it lives here rather than
// once per client, where it would drift.
//
// What is left for a client is genuinely its own: how an emission becomes
// something a person sees, and how a person's answer comes back.
//
//   MW_MODEL          local | fake | http           (default local)
//   MW_COPY           where copy.yaml lives
//   MW_STATE_DIR      where saved games live, the leaderboard among them
//   MW_LEADERBOARD    0 turns it off; a path puts it somewhere else
//   plus the rule dials, all listed in .env.example

import './env.mjs'   // must come first: it fills process.env for the rest

import { readFileSync, watchFile } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import { loadSpecs } from './specs.mjs'
import { createLocalModel } from './model-local.mjs'
import { createHttpModel, resolveMothKey } from './model-http.mjs'
import { createStore } from './store.mjs'
import { createBoard, boardFile } from './board.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
export const ART = join(HERE, 'art')
export const COPY_PATH = process.env.MW_COPY || join(ROOT, 'core', 'copy.yaml')
export const STATE_DIR = process.env.MW_STATE_DIR || join(HERE, 'state')

const envNum = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]))

/** Every dial, read from the environment. See .env.example. */
export function readRules () {
  return {
    steps: envNum('MW_STEPS', 10),
    chartReadouts: envNum('MW_CHART_READOUTS', 15),
    daySteps: envNum('MW_DAY_STEPS', 27),
    weekDays: envNum('MW_WEEK_DAYS', 7),
    startBudget: envNum('MW_START_BUDGET', 1000),
    budgetFloor: envNum('MW_BUDGET_FLOOR', 500),
    quota: envNum('MW_QUOTA', 0.10),
    probation: process.env.MW_PROBATION !== '0',
    probationShare: envNum('MW_PROBATION_SHARE', 0.05),
    weekBonus: envNum('MW_WEEK_BONUS', 100),
    upgradeCost: envNum('MW_UPGRADE_COST', 10),
    regenSteps: envNum('MW_REGEN_STEPS', 9),
    nightSteps: envNum('MW_NIGHT_STEPS', 9),
    counterfactual: process.env.MW_COUNTERFACTUAL !== '0',
  }
}

/**
 * Where the leaderboard lives, or nowhere.
 *
 * `MW_LEADERBOARD=0` gives a board with no file behind it: it still works for
 * the length of a process and is forgotten on restart, which is what a local
 * run usually wants.
 */
export function readBoardOptions () {
  const v = process.env.MW_LEADERBOARD
  if (v === '0') return { file: null }
  return { file: v || boardFile(STATE_DIR) }
}

/** copy.yaml, parsed and wrapped. Throws if the file is unreadable. */
export function readCopy () {
  const parsed = parseYaml(readFileSync(COPY_PATH, 'utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error(`${COPY_PATH}: not a mapping`)
  return createCopy(parsed)
}

/** One of the three physics backends. */
export function buildModel (kind, { worlds, specs }, rules) {
  switch (kind) {
    case 'fake': return createFakeModel({ worlds, steps: rules.steps })
    case 'local': return createLocalModel({ worlds })
    case 'http': return createHttpModel({
      worlds, specs, key: resolveMothKey(),
      api: process.env.MW_MOTH_API || undefined,
      engine: process.env.MW_MOTH_ENGINE || undefined,
      log: (what, d) => console.log(`  moth ${what} ${JSON.stringify(d)}`),
    })
    default: throw new Error(`MW_MODEL=${kind}: expected local, fake or http`)
  }
}

/**
 * Everything assembled: rules, words, worlds, physics, game, store.
 *
 * `watch` re-reads copy.yaml when a writer saves it, so an edit shows in the
 * next message without a restart and without anyone losing their position.
 */
export function createHost ({ model: kind = process.env.MW_MODEL || 'local', watch = true } = {}) {
  const rules = readRules()
  const loaded = loadSpecs({ steps: rules.steps })
  const copy = readCopy()
  const model = buildModel(kind, loaded, rules)
  // Shared by every player and by both clients, which is why it is built here
  // with everything else that is common rather than by whoever asks first.
  const board = createBoard(readBoardOptions())
  const game = createGame({ copy, model, board, rules })
  const store = createStore(STATE_DIR)

  if (watch) {
    watchFile(COPY_PATH, { interval: 700 }, () => {
      try { game.setCopy(readCopy()); console.log('  copy: reloaded') } catch (e) {
        console.error(`  copy: reload failed, keeping previous (${e.message})`)
      }
    })
  }
  return { rules, loaded, copy, model, board, game, store,
           paths: { ROOT, ART, COPY_PATH, STATE_DIR } }
}

/** The same few lines of standing every client prints on the way up. */
export function printBanner (host, what) {
  const { game, model, loaded, rules } = host
  console.log(`\n  OFFICE 4B, 6 MACKENZIE WALK - ${what}`)
  console.log(`  copy     ${COPY_PATH}${game.copy.problems.length ? ` (${game.copy.problems.length} problem(s))` : ''}`)
  console.log(`  worlds   ${loaded.worlds.length} from ${loaded.dir}` +
              (loaded.skipped.length ? `, ${loaded.skipped.length} skipped` : '') +
              (loaded.missingStats.length ? `, ${loaded.missingStats.length} without volatility (run model/warmcache.py)` : ''))
  console.log(`  model    ${model.name}${model.info ? ' ' + JSON.stringify(model.info()) : ''}`)
  console.log(`  day      ${rules.daySteps} steps of ${rules.steps - 1} per world · week ${rules.weekDays} days`)
  console.log(`  state    ${STATE_DIR}`)
  console.log(`  board    ${host.board.file || 'in memory only'}` +
              (() => { const t = host.board.top()
                       const n = t.trade.length + t.day.length + t.week.length
                       return n ? `, ${n} record(s)` : ', empty' })())
  if (model.check) {
    model.check()
      .then((c) => console.log(`  moth     engine ${c.engine_id} ${c.enabled ? 'enabled' : 'DISABLED'}, ${c.credits_per_run} credit(s) a step`))
      .catch((e) => console.error(`  moth     engine check failed: ${e.message}`))
  }
}

/**
 * One turn at a time, per session.
 *
 * A game session is a mutable object that a turn reads and writes. Two turns
 * running over one session at once would interleave their writes, so every
 * session gets a queue of one: a fast tapper waits rather than corrupting their
 * own game. Different sessions never wait on each other.
 *
 * `deliver(id, emissions, session)` is the client's own: it turns the game's
 * emissions into whatever that client shows, and whatever it returns is what
 * the caller gets back. The HTTP client rewrites charts as URLs; the Telegram
 * client sends them and returns them untouched. It is handed the session
 * because a client may need what the game expects NEXT while it is still
 * sending - a chat client puts the buttons on the last message of the burst.
 *
 * `keepLog` records what was delivered, so a client that has to redraw from
 * nothing can replay it. A chat client does not: the messages are still there.
 */
export function createSessions (host, {
  deliver = async (_id, emissions) => emissions,
  keepLog = true,
  seed = () => (Math.random() * 2 ** 31) | 0,
  // Two clients over one store must share this map or they do not exclude each
  // other at all: a player tapping a button in Telegram while a turn from the
  // browser is still running would interleave two writes to the same game.
  // Each client still gets its own `deliver` and its own `keepLog`; the queue
  // is the one thing that has to be common.
  queues = new Map(),
} = {}) {
  const { game, store } = host

  function enqueue (id, job) {
    const prev = queues.get(id) || Promise.resolve()
    const next = prev.then(job, job)
    // the queue must not keep a rejection alive, or every later turn on this
    // session inherits it
    queues.set(id, next.catch(() => {}))
    return next
  }

  /**
   * One job holding several sessions at once, for the rare thing that touches
   * two games - logging in, which may move an anonymous game onto a Telegram
   * id, or replace one with the other.
   *
   * It waits on every queue together rather than taking them one at a time, so
   * two of these running at once cannot each hold what the other is waiting
   * for.
   */
  function enqueueAll (ids, job) {
    const held = [...new Set(ids)]
    const prev = Promise.all(held.map((id) => queues.get(id) || Promise.resolve()))
    const next = prev.then(job, job)
    const quiet = next.catch(() => {})
    for (const id of held) queues.set(id, quiet)
    return next
  }

  /**
   * The saved game for this id, or a new one played up to its first question.
   *
   * `openHeld` is the same thing without taking the queue, and is ONLY for a
   * caller already inside a job holding this id - a login, which has to look at
   * two games at once. Calling plain `open` from in there would wait on the
   * queue entry the caller is itself standing in, which is a deadlock and looks
   * exactly like a hung request.
   */
  async function openHeld (id, { fresh = false } = {}) {
    if (!fresh) {
      const had = await store.load(id)
      if (had) return { id, rec: had, fresh: false }
    }
    const S = game.newSession(seed(id))
    const rec = { session: S, log: [] }
    const r = await game.start(S)
    // Unlike a turn, this is NOT saved when delivery fails, and deliberately:
    // the only thing lost is the opening, and playing it again is better than
    // a player who never saw it being dropped straight into the game.
    const emissions = await deliver(id, r.emissions, S)
    if (keepLog) rec.log.push(...emissions)
    await store.save(id, rec)
    return { id, rec, fresh: true, emissions, choices: r.choices, summary: r.summary }
  }

  async function open (id, options) {
    return enqueue(id, () => openHeld(id, options))
  }

  /**
   * A scene, played on its own, in a game kept for the purpose.
   *
   * For reading copy in a real client - clicking the choices, watching the
   * pacing arrive - without playing the week that would otherwise be in the
   * way. The game it runs in is thrown away and remade on every call, so a
   * preview cannot touch anybody's week and repeating one starts clean.
   *
   * A host decides whether this is reachable at all; nothing here checks.
   */
  async function preview (id, scene, vars = {}) {
    return enqueue(id, async () => {
      const S = game.newSession(seed(id))
      await game.hydrate(S)
      // a scene whose name says which attempt it belongs to should read like it
      S.attempts = Number(vars.attempt) || (/again/.test(scene) ? 3 : 1)
      // The opening is marked seen so that whatever the scene hands back to is
      // the game, not the lift and the lanyard again. A verdict then runs into
      // the day that really follows one, which is a fair part of how it lands.
      S.seqSeen = [...game.copy.list('opening')]
      const rec = { session: S, log: [] }
      const r = game.startScene(S, scene, vars)
      const emissions = await deliver(id, r.emissions, S, { choices: r.choices })
      if (keepLog) rec.log.push(...emissions)
      await store.save(id, rec)
      return { emissions, choices: r.choices, summary: r.summary }
    })
  }

  /**
   * What the player sent, as the transcript should remember it.
   *
   * A token means nothing on its own a week later - `a` was a lift button once
   * - so it is recorded as the LABEL of whatever it answered, and as itself
   * when it answered nothing (free text, an `ask`, a command typed out). The
   * choices have to be read BEFORE the turn, because answering them is exactly
   * what stops them being the ones on offer.
   *
   * It goes in the log and not into the turn's own emissions: a client showing
   * a live turn has already put the player's move on screen its own way, and
   * this is only for the reading back.
   */
  function saidBy (raw, offered) {
    const said = String(raw ?? '').trim()
    if (!said) return null
    const hit = (offered || []).find((c) => String(c.token).toLowerCase() === said.toLowerCase())
    return { kind: 'said', text: hit ? hit.label : said, delay: 0 }
  }

  /**
   * One token in, one turn out.
   *
   * A turn that throws must not leave the player staring at nothing: the error
   * is logged, the copy's own apology is delivered, and the session is saved as
   * it stands so the next message picks up where they were.
   */
  async function turn (id, text) {
    return enqueue(id, async () => {
      const rec = await store.load(id)
      if (!rec) throw Object.assign(new Error('no such session'), { status: 404 })
      const S = rec.session
      // before the turn moves: see saidBy. A game still in its opening has
      // been asked nothing yet, so there is nothing for this to be an answer to
      const said = S.expect === 'boot' ? null : saidBy(text, game.choices(S))
      // A move that reaches the physics backend is a wait, and over the
      // network a long one. Say it was taken before starting it, so the player
      // is not left looking at a live keyboard and a game that appears to have
      // stopped. Delivered and then let go of: it is not part of the turn and
      // does not go in the log, because the transcript already records the
      // move and read back later there is no wait for it to cover.
      const ahead = game.waiting(S, text)
      if (ahead) {
        await deliver(id, [ahead], S, { choices: [], silent: true })
          .catch((e) => console.error(`  ${id}: could not say the wait: ${e?.message || e}`))
      }
      let r
      try {
        r = await game.handle(S, text)
      } catch (e) {
        // The stack, not just the message: a turn that dies quietly looks
        // exactly like a frozen game, and there is nothing to debug from.
        console.error(`  ${id}: turn failed:`, e?.stack || e?.message || e)
        const apology = [{ kind: 'text', text: game.copy.t('scenes.turn_failed') }]
        const failed = await deliver(id, apology, S).catch(() => [])
        if (keepLog) rec.log.push(...(said ? [said] : []), ...failed)
        await store.save(id, rec)
        return { emissions: failed, choices: game.choices(S), summary: game.summary(S), error: String(e?.message || e) }
      }
      // The game has already moved. Whatever happens while showing it, the new
      // state has to reach disk, or the player is handed back a turn they have
      // already spent - the stake gone and the position never opened.
      let emissions = []
      let undelivered = null
      try { emissions = await deliver(id, r.emissions, S) } catch (e) { undelivered = e }
      if (keepLog) rec.log.push(...(said ? [said] : []), ...emissions)
      await store.save(id, rec)
      if (undelivered) throw undelivered
      return { emissions, choices: r.choices, summary: r.summary }
    })
  }

  /** Throw the saved game away and begin again. */
  async function reset (id) {
    await enqueue(id, () => store.remove(id))
    return open(id, { fresh: true })
  }

  return { open, openHeld, turn, preview, reset, enqueue, enqueueAll, queues }
}
