// server.mjs - the deployed program: both clients, one game each.
//
// On a laptop the web client and the bot are two commands and neither knows the
// other exists. That works only for as long as no player is in both: a saved
// game is a file, the store keeps a hot copy in memory, and two processes over
// one directory would each be sure they had the newer one. So the thing that
// actually gets deployed is this - one host, one store, one queue, and two ways
// of talking to it.
//
// What the clients still own separately is how a turn LOOKS: the browser gets a
// page it can replay, Telegram gets messages it cannot. What they share is
// everything about what a turn IS - and, for a player signed in to both, the
// turn itself: host/mirror.mjs says a browser turn again in the chat, which is
// the only thing either client sends without being asked.
//
//   npm start
//
//   PORT, MW_BIND       where the web client listens (127.0.0.1:5090)
//   MW_SECRET           signs the session cookie; required
//   TELEGRAM_BOT_TOKEN  optional here: with no token the site runs on its own
//   the rest are in .env.example

import { createHost, createSessions, printBanner, STATE_DIR } from './host/setup.mjs'
import { createArtifacts } from './host/deliver.mjs'
import { createMirror } from './host/mirror.mjs'
import { createWebServer, createWebDeliver } from './client-http/server.mjs'
import { createBot, COMMANDS } from './client-telegram/bot.mjs'

const PORT = Number(process.env.PORT || 5090)
// Loopback by default. In production Caddy holds the certificate and is the
// only thing that should be able to reach this; binding every interface would
// quietly leave the game served over plain HTTP on port 5090 as well.
const BIND = process.env.MW_BIND || '127.0.0.1'
const SWEEP_HOURS = Number(process.env.MW_SWEEP_HOURS || 12)
const SWEEP_DAYS = Number(process.env.MW_SWEEP_DAYS || 30)

const host = createHost()
const artifacts = createArtifacts({ stateDir: STATE_DIR })

// The one thing both clients must share. Everything else about them differs.
const queues = new Map()

// A turn played on the page is delivered to the page and nowhere else. This is
// what also says it in the chat, for the player who signed in and is in both.
// With no bot it never attaches and the wrapper costs a function call.
const mirror = createMirror({ game: host.game })

const webSessions = createSessions(host, {
  deliver: mirror.wrap(createWebDeliver(artifacts)),
  queues,
})

// ---------------------------------------------------------------------------
// The bot, which is allowed to be absent and allowed to fail
//
// A bad or duplicated bot token is a real problem, but it is the chat's
// problem. Taking the website down over it would turn one broken client into
// two, so it is reported and stepped around.
// ---------------------------------------------------------------------------

const LOCAL = process.env.MW_LOCAL === '1'
const TOKEN = process.env[LOCAL ? 'TELEGRAM_BOT_TOKEN_LOCAL' : 'TELEGRAM_BOT_TOKEN']

let bot = null
let botState = TOKEN ? 'starting' : 'not configured'

async function startBot () {
  if (!TOKEN) {
    console.log('  bot      no token: running the web client alone')
    return null
  }
  const made = createBot({ token: TOKEN, host, artifacts, queues })
  try {
    // also the earliest check that the token works at all
    await made.bot.api.setMyCommands(COMMANDS)
  } catch (e) {
    const bad = e?.error_code === 401 || /401/.test(String(e?.description || e))
    botState = bad ? 'rejected token' : 'unreachable'
    console.error(`  bot      ${bad
      ? 'Telegram rejected the token. Check it against what @BotFather gave you.'
      : `could not reach Telegram: ${e?.description || e?.message || e}`}`)
    console.error('  bot      the web client is unaffected and still serving')
    return null
  }
  // Only now. A token Telegram has already rejected cannot mirror anything, and
  // attaching before the check would turn every browser turn into a failed send.
  mirror.attach(made.deliver)
  // start() resolves only when polling stops, so it is watched, not awaited
  made.bot.start({ onStart: (me) => { botState = 'polling'; console.log(`  bot      polling as @${me.username}`) } })
    .catch((e) => {
      botState = e?.error_code === 409 ? 'another instance holds this token' : 'stopped'
      console.error(`  bot      polling stopped: ${e?.description || e?.message || e}`)
      if (e?.error_code === 409) console.error('  bot      another process is already polling this token')
    })
  return made.bot
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = createWebServer({
  host,
  sessions: webSessions,
  artifacts,
  botStatus: () => botState,
})

printBanner(host, 'web + telegram')
server.listen(PORT, BIND, () => console.log(`  web      http://${BIND}:${PORT}`))
bot = await startBot()

// Old charts, at boot and then twice a day. Unreferenced once the transcript
// they belonged to has scrolled past them; left alone they are the only thing
// here that grows without limit.
artifacts.sweep({ days: SWEEP_DAYS }).catch(() => {})
setInterval(() => artifacts.sweep({ days: SWEEP_DAYS }).catch(() => {}),
            SWEEP_HOURS * 3600e3).unref()

console.log('')

// ---------------------------------------------------------------------------
// Going down
//
// A turn is saved the moment the game has moved, so a hard kill costs at most
// the message a player was mid-way through reading. Draining is still worth the
// few lines: a restart during a deploy should not land in the middle of the one
// step someone paid a stake for.
// ---------------------------------------------------------------------------

let leaving = false
async function shutdown (signal) {
  if (leaving) return
  leaving = true
  console.log(`\n  ${signal}: finishing the turns in flight`)
  const done = setTimeout(() => {
    console.error('  turns did not finish in time; leaving anyway')
    process.exit(1)
  }, 15_000)
  done.unref()
  server.close()
  // Bursts already on their way to a chat, before the bot they are using is
  // stopped out from under them. A mirrored turn is saved either way; this is
  // so the chat is not cut off mid-sentence by a deploy.
  await mirror.drain()
  try { if (bot) await bot.stop() } catch { /* already stopped */ }
  await Promise.allSettled([...queues.values()])
  console.log('  all done\n')
  process.exit(0)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shutdown(signal) })
