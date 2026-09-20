// board.mjs - the leaderboard: the best three of three things, ever.
//
// Every other piece of state in this repository belongs to one player and is
// read and written by one queue. This is the exception: one file, shared by
// everybody, written from whichever turn happens to beat a record. So it is
// held in memory and written behind, and the writes are serialised on a single
// promise chain - two players closing a day in the same tick would otherwise
// each read the board, each add their own row, and each write the other's away.
//
// It is READ synchronously, because the game reads it: core/ takes this as an
// injected port the way it takes the model, and a port that returned promises
// would make a pure state machine wait on a disk. The file is nine rows, so it
// is loaded once at boot and kept.
//
// What goes on it is the player's own typed name, which is the one place in
// the game where one player's words reach another's screen. It is capped and
// stripped here as well as where it was captured, because this is the boundary
// that matters: a hand-edited save, or a copy.yaml with a longer `max` on the
// ask, would otherwise put whatever it liked in front of everybody.

import { readFileSync, existsSync } from 'node:fs'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BOARD_VERSION = 1

/** The three things it tracks, in the order they are shown. */
export const TABLES = ['trade', 'day', 'week']

/** As long a name as a row will carry. The ask that captures one is shorter. */
export const MAX_NAME = 12

const clean = (raw) =>
  [...String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')]
    .slice(0, MAX_NAME)
    .join('')
    .trim()

const rows = (v) => (Array.isArray(v) ? v : [])
  .map((r) => ({ amount: Math.round(Number(r?.amount)), name: clean(r?.name), at: r?.at ?? null }))
  .filter((r) => Number.isFinite(r.amount) && r.amount > 0 && r.name)

/**
 * The board, loaded and ready.
 *
 * `file` defaults to `_leaderboard.json` beside the saved games. A file that
 * cannot be read is an empty board and a warning, never a boot failure: a
 * broken leaderboard must not be the reason nobody can play.
 */
export function createBoard ({ file, keep = 3, now = Date.now,
                               log = (m) => console.warn(`  board: ${m}`) } = {}) {
  let tables = { trade: [], day: [], week: [] }
  let writing = Promise.resolve()
  let pending = false

  if (file && existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      if (d?.version === BOARD_VERSION && d.tables) {
        for (const t of TABLES) tables[t] = rows(d.tables[t]).slice(0, keep)
      }
    } catch (e) {
      log(`${file} is unreadable, starting an empty one (${e.message})`)
    }
  }

  /** Write behind, one at a time. A failed write costs the record, not the turn. */
  function persist () {
    if (!file || pending) return writing
    pending = true
    writing = writing.then(async () => {
      pending = false
      const body = JSON.stringify({ version: BOARD_VERSION, savedAt: new Date(now()).toISOString(), tables })
      const tmp = `${file}.${process.pid}.tmp`
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, body)
      await rename(tmp, file)
    }).catch((e) => { pending = false; log(`could not save (${e.message})`) })
    return writing
  }

  /** Where `amount` would land in a table, 1-based, or null if it would not. */
  function placeOf (table, amount) {
    const at = rows(tables[table]).findIndex((r) => amount > r.amount)
    if (at >= 0) return at + 1
    return tables[table].length < keep ? tables[table].length + 1 : null
  }

  return {
    file,
    keep,

    /** The three tables, newest state, safe to hand out. */
    top () {
      return Object.fromEntries(TABLES.map((t) => [t, tables[t].map((r) => ({ ...r }))]))
    },

    /**
     * Offer a turn's records to the board. Returns the place each one took,
     * 1-based, or null where it took none - which is what a client says
     * "you are on the board" with.
     *
     * A tie does not displace the row already there: the board is a record of
     * who got there first, and a player matching a standing figure has not
     * beaten it.
     */
    post (name, entries = {}) {
      const who = clean(name)
      const took = { trade: null, day: null, week: null }
      if (!who) return took
      let moved = false
      for (const t of TABLES) {
        const amount = Math.round(Number(entries[t]))
        if (!Number.isFinite(amount) || amount <= 0) continue
        const place = placeOf(t, amount)
        if (!place) continue
        tables[t] = [...tables[t], { amount, name: who, at: now() }]
          .sort((a, b) => b.amount - a.amount || a.at - b.at)
          .slice(0, keep)
        took[t] = place
        moved = true
      }
      if (moved) persist()
      return took
    },

    /** Every write finished. For tests, and for a clean shutdown. */
    settled () { return writing },

    /** For tests: an empty board, as though nobody had ever played. */
    clear () {
      tables = { trade: [], day: [], week: [] }
      return persist()
    },
  }
}

/** Where the board lives when nobody says otherwise. */
export const boardFile = (stateDir) => join(stateDir, '_leaderboard.json')
