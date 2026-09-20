// mirror.mjs - a turn played in the browser, said again in the chat.
//
// The two clients share a store and a queue but not a renderer: a turn taken on
// the page is delivered to the page and nowhere else. A player who signs in and
// then plays in the browser watches their chat stay silent, which reads as the
// bot being broken rather than as the bot being quiet. This is the one thing
// that crosses - the web client's deliver, wrapped, so that once the page has
// its turn the same emissions are spoken into Telegram as well.
//
// It is deliberately one-way. The chat already reaches the browser: the web
// client replays the saved log whenever the page is opened, so a day played in
// Telegram is simply there on the next reload. Nothing here pushes the other
// way, and nothing here is on a timer - the bot is still a bot that only speaks
// when spoken to, except for this.

/**
 * A mirror, and the deliver-shaped wrapper that feeds it.
 *
 * `attach` is separate from making one because of the order the program boots
 * in: the web client is built before anyone knows whether the bot's token
 * works. Until it attaches - and forever, if there is no bot - every mirror is
 * a no-op, which is exactly what a site running on its own should do.
 */
export function createMirror ({ game, log = console } = {}) {
  let to = null

  // One burst at a time per player. The chat's delivery is NOT awaited by the
  // turn that caused it (see `wrap`), so without this a fast second click would
  // start its messages while the first burst was still pacing itself out, and
  // the chat would read as two conversations shuffled together.
  const tails = new Map()

  // Who has already been complained about, so a chat that cannot be written to
  // costs one line in the log rather than one line every turn.
  const said = new Set()

  function send (id, emissions, S) {
    if (!to || !emissions?.length) return
    // A guest has no chat to be mirrored into: `web<random>` is the web
    // client's own id, and only `tg<user id>` names somewhere Telegram can be
    // told about. The chat client slices those two characters straight off to
    // get a chat id, so handing it anything else would address a stranger.
    if (!id.startsWith('tg')) return

    // The buttons belong to the state this turn ENDED in, and the session keeps
    // moving underneath: by the time a queued burst is sent, S may be two turns
    // further on. So they are read here, while they are still this turn's, and
    // handed over - rather than letting the chat client read a session that has
    // changed since.
    const choices = S && game ? game.choices(S) : []

    const prev = tails.get(id) || Promise.resolve()
    const next = prev
      .then(() => to(id, emissions, S, choices))
      .then(() => { said.delete(id) })
      .catch((e) => {
        if (said.has(id)) return
        said.add(id)
        // 403 is the ordinary one, and it is not a fault: somebody signed in on
        // the website and has never opened the chat, and a bot may not speak
        // first. Nothing is lost by it either - the game is saved, and /start
        // reads it out where it stands.
        log.error(`  ${id}: not mirrored to the chat (${e?.description || e?.message || e})`)
      })
      .finally(() => { if (tails.get(id) === next) tails.delete(id) })

    tails.set(id, next)
    return next
  }

  return {
    /** The chat client's deliver, once its token is known to work. */
    attach (deliver) { to = deliver },

    /** Whatever is still on its way to a chat, for a shutdown that waits. */
    drain () { return Promise.allSettled([...tails.values()]) },

    /**
     * A deliver that does what it did, and then says it again in the chat.
     *
     * The return value is the wrapped deliver's, untouched: it is what goes
     * into the saved transcript, and the transcript is the browser's.
     */
    wrap (deliver) {
      return async function mirrored (id, emissions, S) {
        const out = await deliver(id, emissions, S)
        // Started, not awaited, and that is the whole design. The chat paces
        // itself - typing indicators and seconds of sleep between the messages
        // of one burst - and `turn` awaits its deliver from inside the
        // session's queue. Awaiting here would hold that queue for the length
        // of the chat's narration: the browser would sit watching its own turn
        // wait for Telegram to finish talking, and the next click would block
        // behind it. The cost of not awaiting is that a failure cannot be
        // reported to the page, which is why it is logged here instead.
        send(id, emissions, S)
        return out
      }
    },
  }
}
