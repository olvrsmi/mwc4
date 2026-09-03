// store.mjs - one saved game per session, as a JSON file.
//
// Each file holds the session and the transcript a client replays when it
// reconnects. Written beside the real file and renamed over it, so a crash
// mid-write cannot leave a half-written save that silently starts a new game.
// The world list is left out and fetched again on load.

import { readFile, writeFile, rename, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const STORE_VERSION = 4

export function createStore (dir, { keepLog = 300 } = {}) {
  const fileFor = (id) => join(dir, `${id}.json`)
  const live = new Map()

  return {
    dir,
    async load (id) {
      if (live.has(id)) return live.get(id)
      const path = fileFor(id)
      if (!existsSync(path)) return null
      try {
        const d = JSON.parse(await readFile(path, 'utf8'))
        if (d?.version !== STORE_VERSION || !d.session) return null
        const rec = { session: d.session, log: d.log || [] }
        live.set(id, rec)
        return rec
      } catch (e) {
        console.warn(`  ${id}: unreadable session (${e.message})`)
        return null
      }
    },
    async save (id, rec) {
      live.set(id, rec)
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
    forget (id) { live.delete(id) },
    async ids () {
      if (!existsSync(dir)) return []
      return (await readdir(dir)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
    },
  }
}
