// store.mjs - one saved game per session, as a JSON file.
//
// Each file holds the session and the transcript a client replays when it
// reconnects. Written beside the real file and renamed over it, so a crash
// mid-write cannot leave a half-written save that silently starts a new game.
// The world list is left out and fetched again on load.

import { readFile, writeFile, rename, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 5: a reading is a Bloch vector rather than a single <Z>, so S.world.readings
// has a shape no earlier save has. A version behind is dropped, not migrated -
// a half-played world cannot be re-read at three axes after the fact.
export const STORE_VERSION = 5

export function createStore (dir, { keepLog = 300, keepLive = Number(process.env.MW_CACHE || 500) } = {}) {
  const fileFor = (id) => join(dir, `${id}.json`)

  /**
   * The games in memory, most recently used last.
   *
   * Every save writes the file before it returns, so dropping a game from here
   * costs a read and nothing else. It has to be dropped eventually: open to
   * anyone, this map would otherwise hold every game anybody ever started, for
   * as long as the process lived.
   *
   * Dropping one is safe only because a session's turns are serialised - see
   * createSessions in setup.mjs. Two turns running over one game at once would
   * each hold their own copy of it, and the slower one would write the other's
   * turn away.
   */
  const live = new Map()
  const touch = (id, rec) => {
    live.delete(id)
    live.set(id, rec)
    while (live.size > keepLive) live.delete(live.keys().next().value)
    return rec
  }

  return {
    dir,
    async load (id) {
      if (live.has(id)) return touch(id, live.get(id))
      const path = fileFor(id)
      if (!existsSync(path)) return null
      try {
        const d = JSON.parse(await readFile(path, 'utf8'))
        if (d?.version !== STORE_VERSION || !d.session) return null
        const rec = { session: d.session, log: d.log || [] }
        touch(id, rec)
        return rec
      } catch (e) {
        console.warn(`  ${id}: unreadable session (${e.message})`)
        return null
      }
    },
    async save (id, rec) {
      touch(id, rec)
      const { allWorlds, ...session } = rec.session
      void allWorlds
      if (rec.log.length > keepLog) rec.log.splice(0, rec.log.length - keepLog)
      await mkdir(dir, { recursive: true })
      const path = fileFor(id)
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: STORE_VERSION, savedAt: new Date().toISOString(),
                                            session, log: rec.log }))
      await rename(tmp, path)
    },
    async remove (id) {
      live.delete(id)
      await rm(fileFor(id), { force: true })
    },
    /** Is there a game under this id at all? Cheaper than loading one. */
    has (id) {
      return live.has(id) || existsSync(fileFor(id))
    },
    /**
     * The same game, under a new id.
     *
     * This is how an anonymous browser game becomes a Telegram player's when
     * they log in: the file is renamed rather than replayed, so nothing about
     * the game changes but the name on it. The live cache has to move with it,
     * or the old id keeps serving the game from memory after the file is gone.
     *
     * Callers must run this inside the session queue for BOTH ids - a rename
     * racing a turn would write the moved game back under its old name.
     */
    async rename (from, to, { overwrite = false } = {}) {
      if (from === to) return false
      if (!existsSync(fileFor(from))) return false
      if (!overwrite && existsSync(fileFor(to))) {
        throw new Error(`rename: ${to} already has a saved game`)
      }
      await mkdir(dir, { recursive: true })
      await rename(fileFor(from), fileFor(to))
      const rec = live.get(from)
      live.delete(from)
      if (rec) touch(to, rec)
      else live.delete(to)
      return true
    },
    /**
     * A copy kept aside before something overwrites this game.
     *
     * Only the player can ask for that - it is what choosing between two saved
     * games means - but a mis-tap should still be recoverable by hand.
     */
    async backup (id) {
      if (!existsSync(fileFor(id))) return null
      const to = join(dir, `${id}.${Date.now().toString(36)}.bak`)
      await copyFile(fileFor(id), to)
      return to
    },
    forget (id) { live.delete(id) },
    /** How many games are held in memory. For tests and for the doctor. */
    get cached () { return live.size },
    async ids () {
      if (!existsSync(dir)) return []
      return (await readdir(dir)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
    },
  }
}
