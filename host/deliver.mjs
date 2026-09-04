// deliver.mjs - the half of delivery both clients share.
//
// A chart becomes a picture exactly once, and it becomes the SAME file whoever
// asked for it. That is what lets a game played in the chat be read back in the
// browser: the saved transcript holds URLs, not bytes, so both clients have to
// agree on what those URLs are. Each client still owns the other half - the web
// hands the page a URL, Telegram uploads the bytes - but neither invents the
// file name any more.
//
// Before this existed the web client rendered charts to disk and the Telegram
// client rendered them to an upload, and a turn taken in the chat left a hole
// in the transcript where the picture should have been.

import { writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { renderEmission, RENDERABLE, artPath } from './render.mjs'

export { RENDERABLE }

/**
 * The shared half of delivery, over one state directory.
 *
 * `chart` returns the bytes for a client that uploads them and the URL for the
 * transcript, so a caller that needs both renders once. A chart that will not
 * draw returns nulls rather than throwing: it costs the reading its picture,
 * never the player their turn.
 */
export function createArtifacts ({ stateDir, log = console }) {
  const pngDir = join(stateDir, 'png')
  let counter = 0

  async function chart (id, e) {
    let png = null
    try {
      png = renderEmission(e)
    } catch (err) {
      log.error(`  ${id}: could not draw a '${e.kind}': ${err.message}`)
      return { png: null, url: null }
    }
    const file = `${id}-${Date.now().toString(36)}-${(counter++).toString(36)}.png`
    try {
      await mkdir(pngDir, { recursive: true })
      await writeFile(join(pngDir, file), png)
    } catch (err) {
      // The bytes are still good, so the client can show this turn's picture.
      // Only the transcript loses it, and that is worth saying out loud.
      log.error(`  ${id}: could not save the chart: ${err.message}`)
      return { png, url: null }
    }
    return { png, url: `/png/${file}` }
  }

  /** The file behind an `art:` name and the URL the page would fetch it by. */
  function art (e) {
    const file = artPath(e.art)
    return { file, url: file ? `/art/${basename(file)}` : null }
  }

  /**
   * Old charts, thrown away.
   *
   * Nothing referenced them any more: the store keeps the last 300 emissions of
   * a transcript and drops the rest, so a picture older than the log is already
   * unreachable. Left alone the directory grows with every turn ever played.
   */
  async function sweep ({ days = 30 } = {}) {
    if (!existsSync(pngDir)) return 0
    const cutoff = Date.now() - days * 86400e3
    let gone = 0
    for (const name of await readdir(pngDir)) {
      if (!name.endsWith('.png')) continue
      const path = join(pngDir, name)
      try {
        if ((await stat(path)).mtimeMs >= cutoff) continue
        await rm(path, { force: true })
        gone++
      } catch { /* a file that vanished under us needed deleting anyway */ }
    }
    if (gone) log.log(`  charts: swept ${gone} older than ${days} days`)
    return gone
  }

  return { pngDir, chart, art, sweep }
}
