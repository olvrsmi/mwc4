// bot.mjs - the Telegram client.
//
// grammY over long polling, so this runs anywhere without a public URL or a
// certificate. The rules live in core/ and the assembly in host/setup.mjs;
// what is here is only what it means to be a chat: turning emissions into
// messages, turning `choices` into inline buttons, and turning a tap back into
// the same short token the player could have typed.
//
// The game is turn-based, so this is a pure request/response bot. 03 had a
// whole unprompted-delivery layer behind it - wake timers, catch-up days, a
// resume sweep at boot - and none of it is carried over: nothing is ever sent
// except in answer to an update.
//
//   TELEGRAM_BOT_TOKEN        required, from @BotFather
//   TELEGRAM_BOT_TOKEN_LOCAL  used instead when MW_LOCAL=1
//   MW_PACE                   scales every delay copy.yaml sets; 0 turns
//                             pacing off entirely
//   MW_ALLOW                  optional comma-separated Telegram user ids
//   MW_MODEL, MW_STATE_DIR    as everywhere else; see .env.example

import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from 'grammy'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost, createSessions, printBanner, STATE_DIR } from '../host/setup.mjs'
import { createArtifacts, RENDERABLE } from '../host/deliver.mjs'
import { stickerOf, isAnimation } from './sticker.mjs'

// Telegram's own caps. Exceeding either is a 400, not a truncation.
export const MAX_TEXT = 4096
export const MAX_CAPTION = 1024
// callback_data is capped at 64 BYTES, not characters
export const MAX_CALLBACK = 64

// A bad request, a blocked bot and a dead chat are all permanent: retrying
// them only burns attempts. Everything else, including a bare network error
// with no code at all, is worth another go.
const PERMANENT = new Set([400, 403, 404])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Text
//
// Telegram's MarkdownV2 needs _*[]()~`>#+-=|{}.! escaped, which holding names
// like grover_n2 and values like -1.000 both trip. HTML mode only cares about
// & < >, so the rules emit a small markdown subset and it is converted here.
// ---------------------------------------------------------------------------

export function toHtml (s) {
  return String(s)
    // first, or the tags written below would be escaped along with the text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    // Emphasis must survive a holding name that contains an underscore. With
    // e_1 in the text, a naive [^_]+ body stops at that underscore and the
    // whole italic silently fails, leaving the delimiters on screen. So the
    // body may contain an underscore when it is inside a word, and only an
    // underscore followed by a non-word character can close the run.
    .replace(/(^|[^\w`])_((?:[^_\n`]|_(?=\w))+)_(?![\w])/g, '$1<i>$2</i>')
}

/**
 * Split a message that will not fit, at the largest boundary that works.
 *
 * The SOURCE is split rather than the converted HTML, because cutting HTML
 * would sooner or later cut through a tag and Telegram would reject the lot.
 * Paragraphs first, then lines, and only then mid-line - the last of which
 * should never happen with hand-written copy, but a scene is a writer's file.
 */
export function splitText (source, limit = MAX_TEXT) {
  const fits = (s) => toHtml(s).length <= limit
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push(buf); buf = '' } }
  const add = (piece, join) => {
    const candidate = buf ? buf + join + piece : piece
    if (fits(candidate)) { buf = candidate; return true }
    return false
  }

  for (const para of String(source ?? '').split(/\n\n+/)) {
    if (add(para, '\n\n')) continue
    flush()
    if (fits(para)) { buf = para; continue }
    for (const line of para.split('\n')) {
      if (add(line, '\n')) continue
      flush()
      if (fits(line)) { buf = line; continue }
      // One line longer than a whole message. Cut it by hand, searching in
      // BOTH directions from a guess: escaping can make the HTML five times
      // the length of the source it came from, so half the limit in source
      // characters is not necessarily half a message.
      let rest = line
      while (rest && !fits(rest)) {
        let take = Math.min(rest.length, Math.max(1, Math.floor(limit / 2)))
        while (take > 1 && !fits(rest.slice(0, take))) take = Math.floor(take / 2)
        while (take < rest.length && fits(rest.slice(0, take + 1))) take += 1
        out.push(rest.slice(0, take))
        rest = rest.slice(take)
      }
      buf = rest
    }
  }
  flush()
  return out.length ? out : ['']
}

// ---------------------------------------------------------------------------
// Keyboards. Derived from the game's own `choices`, so nothing here knows what
// the game is asking - every button carries the token a player could type.
// ---------------------------------------------------------------------------

export function keyboardFor (choices) {
  if (!choices || !choices.length) return undefined
  const k = new InlineKeyboard()

  // A beat is someone at your desk while you are working. Its choices arrive
  // mixed in with the game's and a beat token shadows a game command of the
  // same name, so they get their own row above the rest - otherwise the player
  // cannot tell why answering a conversation was what their tap did.
  const beats = choices.filter((c) => c.kind === 'beat')
  const rest = choices.filter((c) => c.kind !== 'beat')

  const add = (list) => {
    // A world's name or a scene's line needs the whole width; a row of `i` `o`
    // `l` does not. Telegram allows eight to a row, but three reads better and
    // keeps the labels legible on a phone.
    const wide = list.some((c) => String(c.label ?? '').length > 24)
    const perRow = wide ? 1 : Math.min(3, list.length)
    list.forEach((c, i) => {
      // callback_data is 1 to 64 BYTES, and Telegram rejects both ends at send
      // time rather than when the keyboard is built
      const token = Buffer.from(String(c.token ?? '')).subarray(0, MAX_CALLBACK).toString() || '?'
      k.text(String(c.label ?? c.token ?? '?'), token)
      if ((i + 1) % perRow === 0 && i + 1 < list.length) k.row()
    })
  }

  if (beats.length) { add(beats); if (rest.length) k.row() }
  add(rest)
  return k
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

/**
 * A session id per player, namespaced so it cannot collide with a browser one.
 *
 * Keyed on the Telegram USER id, not the chat id. They are the same number in a
 * private chat - which is the only kind this bot answers, see below - but the
 * Login Widget on the web vouches for a user, and this has to be the same id it
 * hands over or logging in would find nobody's game.
 */
export const sessionId = (userId) => `tg${userId}`
/** Where to send: in a private chat the user id IS the chat id. */
const chatOf = (id) => id.slice(2)

export function createBot ({
  token,
  host = createHost(),
  artifacts = createArtifacts({ stateDir: STATE_DIR }),
  // Shared with the web client when both run in one process, so a tap here and
  // a turn there cannot interleave over the same saved game.
  queues = undefined,
  // How long each message waits is the copy editor's, set in copy.yaml under
  // `pacing:` and stamped on every emission. This only scales it: 1 plays it
  // as written, 2 plays it at half speed, 0 sends the burst as fast as
  // Telegram will take it, which is what the tests want.
  pace = process.env.MW_PACE,
  allow = (process.env.MW_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Supplying botInfo skips the getMe call grammY would otherwise make before
  // it will handle an update, which is what lets a test drive the bot with
  // bot.handleUpdate() and an api transformer, and never reach the network.
  botInfo = undefined,
} = {}) {
  if (!token) throw new Error('createBot: a bot token is required')
  // A blank or misspelt MW_PACE must not read as 0. Silently unpaced is the
  // one wrong answer here: it looks exactly like the feature not existing,
  // and nobody would think to check an environment variable for it.
  const scale = Number.isFinite(Number(pace)) && pace !== '' && Number(pace) >= 0 ? Number(pace) : 1
  if (pace !== undefined && Number(scale) !== Number(pace)) {
    console.warn(`  MW_PACE='${pace}' is not a number; playing the copy's timing as written.`)
  }
  const bot = new Bot(token, botInfo ? { botInfo } : undefined)
  const { game } = host

  /** Never let a decoration take a turn down. */
  const action = (chatId, what) => bot.api.sendChatAction(chatId, what).catch(() => {})

  async function sendWithRetry (fn, chatId, attempts = 3) {
    let wait = 1000
    for (let i = 1; ; i++) {
      try {
        return await fn()
      } catch (e) {
        const code = e?.error_code
        if (PERMANENT.has(code) || i >= attempts) throw e
        // 429 is flood control and it says how long to wait. Guessing shorter
        // than Telegram asked for is what turns one throttled send into a
        // cascade of them.
        const after = Number(e?.parameters?.retry_after)
        const pause = Number.isFinite(after) && after > 0 ? Math.max(wait, after * 1000) : wait
        console.warn(`  ${chatId}: send failed (${e?.description || e?.message}), ` +
                     `retry ${i}/${attempts - 1} in ${pause}ms`)
        await sleep(pause)
        wait *= 3
      }
    }
  }

  /** A message, split if it will not fit, with the keyboard on the last part. */
  async function sendText (chatId, source, reply_markup) {
    const parts = splitText(source)
    for (let p = 0; p < parts.length; p++) {
      const last = p === parts.length - 1
      await sendWithRetry(() => bot.api.sendMessage(chatId, toHtml(parts[p]), {
        parse_mode: 'HTML', ...(last && reply_markup ? { reply_markup } : {}),
      }), chatId)
    }
  }

  /** Speaker and line, as the one string the markdown subset understands. */
  const spoken = (e) => {
    const body = String(e.text ?? '')
    if (!e.speaker) return body
    return body.trim() ? `**${e.speaker}**\n${body}` : `**${e.speaker}**`
  }

  /**
   * Emissions become messages, in order.
   *
   * The keyboard rides the LAST message of the burst and nothing before it: a
   * keyboard halfway up offers a decision the player has not been told about
   * yet, and leaves a dead one above the live one.
   */
  async function deliver (id, emissions, S) {
    const chatId = chatOf(id)
    const choices = S ? game.choices(S) : []
    // What goes in the transcript, in the same shape the web client writes: a
    // chart as the URL of the file it was rendered to, not as bytes. A game
    // played here has to be readable there.
    const out = []
    for (let i = 0; i < emissions.length; i++) {
      const e = emissions[i]
      const last = i === emissions.length - 1
      const reply_markup = last ? keyboardFor(choices) : undefined

      // A burst arrives a beat apart with a typing indicator, so it reads as
      // someone talking rather than as four messages at once. Nothing waits
      // before the FIRST message: that one is the answer to what the player
      // just did, and pausing on it reads as the bot being slow.
      const wait = i > 0 ? Math.round((Number(e.delay) || 0) * scale) : 0
      if (wait > 0) {
        await action(chatId, 'typing')
        await sleep(wait)
      }

      if (e.kind === 'text') {
        await sendText(chatId, spoken(e), reply_markup)
        out.push(e)
        continue
      }

      if (e.kind === 'art') {
        const { file, url } = artifacts.art(e)
        out.push({ ...e, url })
        const line = spoken(e)
        const hasLine = Boolean(line.trim())
        if (!file) {
          // not drawn yet: play the line without the picture rather than nothing
          console.warn(`  ${chatId}: no file for art '${e.art}'`)
          if (hasLine) await sendText(chatId, line, reply_markup)
          continue
        }
        // The media goes on its own and the line follows as its own message.
        // That was already wanted - a caption is what makes Telegram fit a
        // picture to the text column - and sendSticker forces it: there is no
        // caption parameter at all. The keyboard rides the last of the pair.
        const onMedia = hasLine ? undefined : reply_markup
        let sent = false
        if (!isAnimation(file)) {
          await action(chatId, 'choose_sticker')
          try {
            const webp = await stickerOf(file)
            await sendWithRetry(() => bot.api.sendSticker(chatId,
              new InputFile(webp, `${e.art}.webp`),
              onMedia ? { reply_markup: onMedia } : {}), chatId)
            sent = true
          } catch (err) {
            // A picture that will not convert should cost the scene its
            // picture, not its line. Said out loud, because a silent fallback
            // here would look like it worked.
            console.error(`  ${chatId}: ${e.art} would not convert to a sticker: ${err.message}`)
          }
        }
        if (!sent) {
          const moving = isAnimation(file)
          await action(chatId, moving ? 'upload_video' : 'upload_photo')
          const send = moving ? bot.api.sendAnimation.bind(bot.api) : bot.api.sendPhoto.bind(bot.api)
          await sendWithRetry(() => send(chatId, new InputFile(file),
            onMedia ? { reply_markup: onMedia } : {}), chatId)
        }
        if (hasLine) await sendText(chatId, line, reply_markup)
        continue
      }

      if (RENDERABLE.has(e.kind)) {
        await action(chatId, 'upload_photo')
        // Rendered once, to the same file the web client would have written:
        // the bytes go to Telegram, the URL goes in the transcript. A chart
        // that will not draw costs the reading its picture, not the player
        // their turn - the numbers are in the caption either way.
        const { png, url } = await artifacts.chart(id, e)
        out.push({ ...e, png: url })
        if (!png) {
          if (e.caption) await sendText(chatId, e.caption, reply_markup)
          continue
        }
        // A reading and the picture of it are one thing, so they travel as one
        // message. A caption over 1024 characters falls back to two.
        const cap = e.caption ? toHtml(e.caption) : null
        const fits = cap !== null && cap.length <= MAX_CAPTION
        if (cap !== null && !fits) await sendText(chatId, e.caption, undefined)
        await sendWithRetry(() => bot.api.sendPhoto(chatId, new InputFile(png, 'chart.png'), {
          ...(fits ? { caption: cap, parse_mode: 'HTML' } : {}),
          ...(reply_markup ? { reply_markup } : {}),
        }), chatId)
        continue
      }

      // Not throwing: one unknown emission should not lose the rest of a turn.
      // But it must not vanish either - that is a message the player was meant
      // to get, gone with nothing said anywhere.
      console.error(`  ${chatId}: no way to deliver a '${e.kind}' emission`)
      out.push(e)
    }
    return out
  }

  const sessions = createSessions(host, {
    deliver,
    queues,
    // The chat is this client's own transcript and it never replays the log.
    // It is kept anyway, because the browser does replay it: without this, a
    // player who plays a day in the chat and then opens the web client finds a
    // game that has silently jumped forward with no record of how.
    keepLog: true,
    seed: (id) => {
      // stable per chat, so the same chat restarted gets the same worlds only
      // if it is genuinely the same game; the id is the only thing to hand
      let h = 0
      for (const c of String(id)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
      return h
    },
  })

  /**
   * One update, one turn.
   *
   * A chat with no saved game gets the opening rather than an error, and the
   * message that arrived is what started it - so a stranger typing anything is
   * walked in, exactly as /start would.
   */
  async function handleToken (chatId, text) {
    const id = sessionId(chatId)
    const opened = await sessions.open(id)
    if (opened.fresh) return
    return sessions.turn(id, text)
  }

  /** Nothing below is allowed to take the process down. */
  const guard = (chatId, promise) => Promise.resolve(promise).catch((e) => {
    console.error(`  ${chatId}: ${e?.stack || e?.description || e?.message || e}`)
  })

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  bot.use(async (ctx, next) => {
    if (allow.length && !allow.includes(String(ctx.from?.id))) {
      if (ctx.chat) await ctx.reply('This prototype is not open just now.').catch(() => {})
      return
    }
    return next()
  })

  /**
   * Private chats only.
   *
   * A game is one person's, and the id it is saved under is the player's user
   * id - which only equals the chat id in a one-to-one chat. In a group the two
   * diverge, and everyone in the room would be taking turns in whichever game
   * the chat id happened to name. It is also simply not a game to play in
   * public: the whole thing is someone's private week at work.
   */
  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type
    if (type && type !== 'private') {
      if (ctx.message) {
        await ctx.reply('This one is played in a private chat. Message me directly.').catch(() => {})
      }
      return
    }
    return next()
  })

  /** Who is playing. In a private chat this is also where to send. */
  const who = (ctx) => String(ctx.from?.id ?? ctx.chat?.id)

  bot.command('start', async (ctx) => {
    const chatId = who(ctx)
    await guard(chatId, (async () => {
      const opened = await sessions.open(sessionId(chatId))
      // Telegram sends /start whenever someone reopens the bot, so it must not
      // cost anyone their week. A game already in progress is picked up where
      // it stands; /restart is the one that throws it away.
      if (!opened.fresh) await sessions.turn(sessionId(chatId), 'state')
    })())
  })

  bot.command('restart', async (ctx) => {
    const chatId = who(ctx)
    await guard(chatId, sessions.reset(sessionId(chatId)))
  })

  for (const [command, token] of [['help', 'help'], ['status', 'state'], ['market', 'm'], ['skip', 'skip']]) {
    bot.command(command, async (ctx) => {
      const chatId = who(ctx)
      await action(chatId, 'typing')
      await guard(chatId, handleToken(chatId, token))
    })
  }

  /**
   * Whether a tapped button is still one of the buttons on offer.
   *
   * Telegram leaves every keyboard ever sent live and tappable, and the game's
   * tokens are heavily reused: `5` is a world, a stake, a holding and an exit
   * point depending on where you are. So a tap on a keyboard from four
   * messages ago is not inert, it is a different, legal, wrong move - staking
   * 5G because the button used to mean t5. Typing `5` is the player saying it
   * on purpose; tapping a stale button is not, so only taps are held to this.
   */
  async function offered (id, token) {
    const rec = await host.store.load(id)
    if (!rec) return true      // no game yet: let it through and be walked in
    return game.choices(rec.session).some((c) => String(c.token) === String(token))
  }

  bot.on('callback_query:data', async (ctx) => {
    const chatId = who(ctx)
    const data = ctx.callbackQuery.data
    let stale = false
    try {
      stale = !(await offered(sessionId(chatId), data))
    } catch (e) {
      console.error(`  ${chatId}: could not check the button: ${e?.message || e}`)
    }
    // Answer first and always: an unanswered query spins on the client, and
    // one answered too late is a 400 nobody can do anything about.
    await ctx.answerCallbackQuery(stale ? { text: game.copy.t('prompts.stale_button') } : undefined)
      .catch(() => {})
    if (stale) return
    await action(chatId, 'typing')
    await guard(chatId, handleToken(chatId, data))
  })

  bot.on('message:text', async (ctx) => {
    const chatId = who(ctx)
    await action(chatId, 'typing')
    await guard(chatId, handleToken(chatId, ctx.message.text))
  })

  bot.catch((err) => {
    const e = err.error
    if (e instanceof GrammyError) console.error('  telegram:', e.description)
    else if (e instanceof HttpError) console.error('  network:', e.message)
    else console.error('  bot error:', e)
  })

  return { bot, host, sessions, deliver, handleToken }
}

export const COMMANDS = [
  { command: 'start', description: 'begin, or pick up where you left off' },
  { command: 'status', description: 'your qubit, coherence and balance' },
  { command: 'market', description: 'the workshop' },
  { command: 'help', description: 'how any of this works' },
  { command: 'skip', description: 'skip the opening scenes' },
  { command: 'restart', description: 'throw this game away and start again' },
]

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Telegram allows exactly one long poll per token and a second one evicts
  // the first, so a laptop and a server cannot share a bot. MW_LOCAL picks the
  // development one.
  const LOCAL = process.env.MW_LOCAL === '1'
  const TOKEN_VAR = LOCAL ? 'TELEGRAM_BOT_TOKEN_LOCAL' : 'TELEGRAM_BOT_TOKEN'
  const TOKEN = process.env[TOKEN_VAR]
  if (!TOKEN) {
    console.error(`\n  ${TOKEN_VAR} is not set.`)
    console.error(LOCAL
      ? '  MW_LOCAL=1 wants a second bot, so it does not fight the deployed one.'
      : '  Create a bot with @BotFather, then put its token in .env.')
    console.error('  See .env.example.\n')
    process.exit(78)      // EX_CONFIG: a supervisor should not restart on this
  }

  const { bot, host } = createBot({ token: TOKEN })

  try {
    // also the earliest check that the token works at all
    await bot.api.setMyCommands(COMMANDS)
  } catch (e) {
    const badToken = e?.error_code === 401 || /401/.test(String(e?.description || e))
    console.error(`\n  ${badToken
      ? `Telegram rejected the token (401 Unauthorized). Check ${TOKEN_VAR} against what @BotFather gave you.`
      : `Could not reach Telegram: ${e?.description || e?.message || e}`}\n`)
    // a rejected token will not fix itself; an unreachable Telegram might
    process.exit(badToken ? 78 : 1)
  }

  printBanner(host, 'telegram')
  console.log(`  bot      ${LOCAL ? 'development (MW_LOCAL=1)' : 'deployed'}`)
  if (process.env.MW_ALLOW) console.log(`  allow    ${process.env.MW_ALLOW.split(',').filter(Boolean).length} user id(s)`)

  try {
    await bot.start({ onStart: (me) => console.log(`  polling as @${me.username}\n`) })
  } catch (e) {
    if (e?.error_code === 409) {
      console.error('\n  409: another instance is already polling this token.' +
                    '\n  Stop it first:  pkill -f "node client-telegram/bot.mjs"\n')
    } else {
      console.error(`\n  polling stopped: ${e?.description || e?.message || e}\n`)
    }
    // restarting into a token someone else holds just fights them
    process.exit(e?.error_code === 409 ? 78 : 1)
  }
}
