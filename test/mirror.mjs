// mirror.mjs - a browser turn arriving in the chat.
//
//   node test/mirror.mjs
//
// Most of this drives host/mirror.mjs against a stand-in for the chat client,
// because what is worth pinning down is not how a message looks - telegram.mjs
// covers that - but when it is sent, in what order, and what happens when
// Telegram refuses it. The last section wires the real bot's deliver in behind
// it, so the seam the whole thing depends on cannot quietly stop fitting.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import { loadSpecs } from '../host/specs.mjs'
import { createStore } from '../host/store.mjs'
import { createArtifacts } from '../host/deliver.mjs'
import { createMirror } from '../host/mirror.mjs'
import { createBot } from '../client-telegram/bot.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COPY = parseYaml(readFileSync(join(ROOT, 'core', 'copy.yaml'), 'utf8'))

let failures = 0
let passes = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passes += 1; return console.log(`  pass  ${name}`) }
  failures += 1
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
const section = (name) => console.log(`\n  -- ${name}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = () => { const lines = []; return { lines, error: (m) => lines.push(String(m)) } }

/** A mirror over a stand-in chat, and the wrapped deliver that feeds it. */
function rig ({ to, game = { choices: (S) => S?.choices || [] } } = {}) {
  const log = quiet()
  const mirror = createMirror({ game, log })
  const web = []
  // what the web client's own deliver would do: hand back the emissions it was
  // given, which is what the transcript keeps
  const mirrored = mirror.wrap(async (id, emissions) => {
    web.push(id)
    return emissions.map((e) => ({ ...e, seen: true }))
  })
  if (to) mirror.attach(to)
  return { mirror, mirrored, web, log }
}

const text = (t) => [{ kind: 'text', text: t }]

// ---------------------------------------------------------------------------
section('what crosses, and what does not')
{
  const sent = []
  const { mirrored, mirror } = rig({ to: async (id, em) => { sent.push([id, em[0].text]) } })

  const out = await mirrored('tg42', text('one'), { choices: [] })
  await mirror.drain()
  ok('a signed-in turn is said again in the chat', sent.length === 1 && sent[0][0] === 'tg42')
  ok('and the wrapped deliver still owns what the transcript keeps',
     out.length === 1 && out[0].seen === true && out[0].text === 'one')

  await mirrored('web9f3c', text('two'), { choices: [] })
  await mirror.drain()
  ok('a guest turn is not, having no chat to be mirrored into', sent.length === 1)

  await mirrored('tg42', [], { choices: [] })
  await mirror.drain()
  ok('and an empty burst is not sent at all', sent.length === 1)
}

// ---------------------------------------------------------------------------
section('with no bot behind it')
{
  const { mirrored, mirror, log } = rig()          // nothing attached
  const out = await mirrored('tg42', text('one'), { choices: [] })
  await mirror.drain()
  ok('the turn is delivered to the page as usual', out[0].seen === true)
  ok('and nothing is logged about a chat that does not exist', log.lines.length === 0)
}

// ---------------------------------------------------------------------------
section('the turn does not wait for the chat')
{
  // the point of the whole design: the chat paces itself over seconds, and
  // `turn` awaits its deliver from inside the session's queue
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const { mirrored, mirror } = rig({
    to: async () => { await gate; order.push('chat') },
  })

  const done = mirrored('tg42', text('one'), { choices: [] })
  await done
  order.push('the page has its turn')
  release()
  await mirror.drain()

  ok('the page is answered before the chat has finished talking',
     order.join(' | ') === 'the page has its turn | chat', order.join(' | '))
}

// ---------------------------------------------------------------------------
section('two turns in a hurry')
{
  const arrived = []
  const { mirrored, mirror } = rig({
    to: async (id, em) => { await sleep(em[0].text === 'one' ? 30 : 0); arrived.push(em[0].text) },
  })

  await mirrored('tg42', text('one'), { choices: [] })
  await mirrored('tg42', text('two'), { choices: [] })
  await mirror.drain()
  ok('a second burst waits for the first, rather than shuffling into it',
     arrived.join(',') === 'one,two', arrived.join(','))

  const both = []
  const two = rig({ to: async (id) => { await sleep(id === 'tg1' ? 20 : 0); both.push(id) } })
  await two.mirrored('tg1', text('a'), { choices: [] })
  await two.mirrored('tg2', text('b'), { choices: [] })
  await two.mirror.drain()
  ok('but two players do not wait for each other', both.join(',') === 'tg2,tg1', both.join(','))
}

// ---------------------------------------------------------------------------
section('the keyboard belongs to the turn, not to the session')
{
  // the session keeps moving while a burst is queued behind another one
  const S = { choices: [{ token: 'a', label: 'first' }] }
  const seen = []
  const { mirrored, mirror } = rig({
    to: async (id, em, _S, choices) => { await sleep(10); seen.push(choices.map((c) => c.token).join('')) },
  })

  await mirrored('tg42', text('one'), S)
  S.choices = [{ token: 'b', label: 'second' }]
  await mirrored('tg42', text('two'), S)
  await mirror.drain()

  ok('a queued burst carries the choices its own turn ended with',
     seen.join(',') === 'a,b', seen.join(','))
}

// ---------------------------------------------------------------------------
section('a chat that will not take it')
{
  // the ordinary case: signed in on the website, never opened the chat, and a
  // bot may not speak first
  let refuse = true
  const { mirrored, mirror, log } = rig({
    to: async () => { if (refuse) throw Object.assign(new Error('x'), { error_code: 403, description: 'bot cannot initiate conversation with a user' }) },
  })

  const out = await mirrored('tg42', text('one'), { choices: [] })
  await mirror.drain()
  ok('the page still gets its turn', out[0].seen === true)
  ok('and is told nothing about it', out[0].error === undefined)
  ok('the reason is logged', log.lines.length === 1 && /cannot initiate/.test(log.lines[0]), log.lines.join('|'))

  for (const t of ['two', 'three']) { await mirrored('tg42', text(t), { choices: [] }) }
  await mirror.drain()
  ok('once, not once a turn', log.lines.length === 1, `${log.lines.length} lines`)

  refuse = false
  await mirrored('tg42', text('four'), { choices: [] })
  await mirror.drain()
  refuse = true
  await mirrored('tg42', text('five'), { choices: [] })
  await mirror.drain()
  ok('and again if it breaks after a chat has started working', log.lines.length === 2,
     `${log.lines.length} lines`)
}

// ---------------------------------------------------------------------------
section('the seam the chat client actually presents')
{
  const dir = await mkdtemp(join(tmpdir(), 'mw4-mirror-'))
  const specs = loadSpecs({ steps: 10 })
  const copy = createCopy(COPY, { random: () => 0 })
  const game = createGame({ copy, model: createFakeModel({ worlds: specs.worlds }) })
  const host = { rules: game.rules, loaded: specs, copy, model: game.model, game, store: createStore(dir) }
  const artifacts = createArtifacts({ stateDir: dir, log: { log () {}, error () {} } })
  const sent = []
  const made = createBot({
    token: '424242:TEST-TOKEN', host, artifacts, pace: 0,
    botInfo: { id: 4242, is_bot: true, first_name: 'Mackenzie', username: 'mw_test_bot' },
  })
  made.bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload })
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } } }
  })

  const log = quiet()
  // The stand-in reader again, not the real game: what is under test here is
  // that the chat client's deliver still takes what the mirror hands it, and a
  // real session would only put the rules between the two of them.
  const mirror = createMirror({ game: { choices: (S) => S?.choices || [] }, log })
  mirror.attach(made.deliver)
  const mirrored = mirror.wrap(async (id, emissions) => emissions)

  const choices = [{ token: 'y', label: 'Take it' }, { token: 'n', label: 'Leave it' }]
  await mirrored('tg42', text('Daniel holds out a lanyard'), { choices })
  await mirror.drain()

  const msgs = sent.filter((s) => s.method === 'sendMessage')
  ok('the real deliver takes the mirror and sends to the right chat',
     msgs.length === 1 && String(msgs[0].payload.chat_id) === '42', JSON.stringify(sent.map((s) => s.method)))
  ok('the text arrives', /lanyard/.test(msgs[0]?.payload?.text || ''))
  ok('and the buttons the turn ended with ride the last message',
     (msgs[0]?.payload?.reply_markup?.inline_keyboard || []).flat().length === 2)
  ok('nothing was logged as a failure', log.lines.length === 0, log.lines.join('|'))

  await rm(dir, { recursive: true, force: true })
}

console.log(`\n  ${passes} passed${failures ? `, ${failures} FAILED` : ', all good'}\n`)
process.exit(failures ? 1 : 0)
