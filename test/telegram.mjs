// telegram.mjs - the Telegram client, driven without a bot token.
//
//   node test/telegram.mjs
//
// grammY will hand every outbound call to a transformer instead of the network,
// and bot.handleUpdate() feeds it updates directly, so a whole conversation
// happens in memory: no token, no polling, no Telegram. What is checked is the
// part that is genuinely this client's - HTML, splitting, keyboards, stickers,
// retries, and which message the buttons land on.

import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { loadImage, createCanvas } from '@napi-rs/canvas'

import { createCopy } from '../core/copy.mjs'
import { createGame } from '../core/game.mjs'
import { createFakeModel } from '../core/fake-model.mjs'
import { loadSpecs } from '../host/specs.mjs'
import { createStore } from '../host/store.mjs'
import { createArtifacts } from '../host/deliver.mjs'
import { artPath, ART } from '../host/render.mjs'
import { createBot, toHtml, splitText, keyboardFor, sessionId, MAX_TEXT } from '../client-telegram/bot.mjs'
import { stickerOf, STICKER_SIDE, isAnimation } from '../client-telegram/sticker.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COPY = parseYaml(readFileSync(join(ROOT, 'core', 'copy.yaml'), 'utf8'))
const specs = loadSpecs({ steps: 10 })

let failures = 0
let passes = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passes += 1; return console.log(`  pass  ${name}`) }
  failures += 1
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
const section = (name) => console.log(`\n  -- ${name}`)

const BOT_INFO = {
  id: 4242, is_bot: true, first_name: 'Mackenzie', username: 'mw_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
}

/** A bot wired to the fake physics, a scratch store, and a captured API. */
async function harness ({ fail = null, seedDir = null } = {}) {
  const dir = seedDir || await mkdtemp(join(tmpdir(), 'mw4-tg-'))
  const copy = createCopy(COPY, { random: () => 0 })
  const model = createFakeModel({ worlds: specs.worlds })
  const game = createGame({ copy, model })
  const host = { rules: game.rules, loaded: specs, copy, model, game, store: createStore(dir) }
  const sent = []
  // charts to the scratch directory, not to the real host/state/png
  const artifacts = createArtifacts({ stateDir: dir, log: { log () {}, error () {} } })
  const made = createBot({ token: '424242:TEST-TOKEN', host, artifacts, pace: 0, botInfo: BOT_INFO })
  let messageId = 100
  made.bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload })
    const thrown = fail && fail(method, payload, sent)
    if (thrown) throw thrown
    return { ok: true, result: { message_id: messageId++, date: 0, chat: { id: 42, type: 'private' } } }
  })
  return { ...made, sent, dir, game, cleanup: () => (seedDir ? Promise.resolve() : rm(dir, { recursive: true, force: true })) }
}

/**
 * Past the opening. It asks the player their name before it will be skipped,
 * so a test that only wants to be in the game answers that first. The chat
 * must already exist: the first message to a new one only walks them in.
 */
const enter = async (bot, id) => { await say(bot, 'OJS', id); await say(bot, 'skip', id) }

let updateId = 0
// In a private chat - the only kind the bot answers - Telegram's chat.id and
// from.id are the same number, and the bot keys a game on the user. These
// fixtures used to give them different values, which passed only for as long as
// the chat was what identified a player.
const say = (bot, text, chat = 42) => bot.handleUpdate({
  update_id: ++updateId,
  message: { message_id: ++updateId, date: 0, text, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false, first_name: 'Tester' } },
})
const tap = (bot, data, chat = 42) => bot.handleUpdate({
  update_id: ++updateId,
  callback_query: { id: String(++updateId), data, chat_instance: 'x', from: { id: chat, is_bot: false, first_name: 'Tester' }, message: { message_id: 1, date: 0, chat: { id: chat, type: 'private' } } },
})
/** A message from a group, which the bot should not play. */
const sayInGroup = (bot, text, chat = -100123) => bot.handleUpdate({
  update_id: ++updateId,
  message: { message_id: ++updateId, date: 0, text, chat: { id: chat, type: 'supergroup' }, from: { id: 7, is_bot: false, first_name: 'Tester' } },
})

const msgs = (sent) => sent.filter((s) => s.method === 'sendMessage')
const kbOf = (s) => s.payload?.reply_markup?.inline_keyboard
const texts = (sent) => msgs(sent).map((s) => s.payload.text)

// ---------------------------------------------------------------------------
section('the markdown subset')
{
  ok('escapes the three characters HTML cares about',
     toHtml('a & b < c > d') === 'a &amp; b &lt; c &gt; d')
  ok('escaping happens before the tags are written, not after',
     toHtml('**<b>**') === '<b>&lt;b&gt;</b>')
  ok('bold, italic and code', toHtml('**a** _b_ `c`') === '<b>a</b> <i>b</i> <code>c</code>')
  ok('an underscore inside a word does not open emphasis',
     toHtml('spec_n3_01 stands alone') === 'spec_n3_01 stands alone')
  ok('and emphasis survives a name that contains one',
     toHtml('_a phase on e_1 and e_2_') === '<i>a phase on e_1 and e_2</i>')
  ok('a holding ticker in code stays intact', toHtml('`grover_n2`') === '<code>grover_n2</code>')
  ok('an unbalanced delimiter is left alone rather than breaking the send',
     toHtml('what _now') === 'what _now')
  // player-supplied text arrives here through an `ask` node
  ok('a player cannot inject markup', !/[<>]/.test(toHtml('<script>alert(1)</script>').replace(/&lt;|&gt;/g, '')))
  ok('nor break out of a tag', toHtml('</b>') === '&lt;/b&gt;')
}

// ---------------------------------------------------------------------------
section('splitting a message Telegram would refuse')
{
  ok('a short message is one part', splitText('hello').length === 1)
  ok('empty is still one part, not none', splitText('').length === 1)
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} `.repeat(20)).join('\n\n')
  const parts = splitText(paras)
  ok('a long message splits', parts.length > 1, `${parts.length} parts`)
  ok('every part fits once converted', parts.every((p) => toHtml(p).length <= MAX_TEXT),
     parts.map((p) => toHtml(p).length).join(','))
  ok('and nothing is lost', parts.join('\n\n').replace(/\s+/g, ' ').trim() === paras.replace(/\s+/g, ' ').trim())
  const oneLine = 'x'.repeat(MAX_TEXT * 2 + 17)
  const hard = splitText(oneLine)
  ok('a single line longer than a message is hard-cut', hard.length >= 3 && hard.every((p) => toHtml(p).length <= MAX_TEXT))
  ok('and the hard cut loses nothing', hard.join('') === oneLine)
  // escaping makes the HTML longer than the source, so the budget is the HTML
  const amps = '&'.repeat(2000)
  ok('the limit is measured on the converted text, not the source',
     splitText(amps).every((p) => toHtml(p).length <= MAX_TEXT))
}

// ---------------------------------------------------------------------------
section('keyboards')
{
  ok('no choices means no keyboard', keyboardFor([]) === undefined && keyboardFor(undefined) === undefined)
  const short = keyboardFor([{ token: 'i', label: 'Invest' }, { token: 'o', label: 'Observe' }, { token: 'l', label: 'Leave' }])
  ok('short labels share a row', short.inline_keyboard.length === 1 && short.inline_keyboard[0].length === 3)
  const wide = keyboardFor([{ token: '1', label: '1. Curiosity Metro — 7 opportunities' }, { token: '2', label: '2. Tiger Eaten — 3 opportunities' }])
  ok('a long label takes the whole row', wide.inline_keyboard.length === 2)
  const many = keyboardFor(Array.from({ length: 8 }, (_, i) => ({ token: `${i}`, label: `t${i}` })))
  ok('a wide set wraps at three', many.inline_keyboard.every((r) => r.length <= 3) && many.inline_keyboard.length === 3)
  ok('no trailing empty row', many.inline_keyboard.every((r) => r.length > 0))
  ok('the button carries the token a player could type',
     short.inline_keyboard[0].map((b) => b.callback_data).join() === 'i,o,l')
  ok('callback data stays inside 64 bytes',
     keyboardFor([{ token: 'x'.repeat(200), label: 'long' }]).inline_keyboard[0][0].callback_data.length <= 64)
  ok('and is never empty, which Telegram also refuses',
     keyboardFor([{ token: '', label: 'x' }]).inline_keyboard[0][0].callback_data.length >= 1)

  // a beat arrives mid-game and its tokens sit alongside the game's own
  const mixed = keyboardFor([
    { token: 'a', label: 'Humour him', kind: 'beat' },
    { token: 'b', label: 'Point at the quota', kind: 'beat' },
    { token: 'h', label: 'Hold', kind: 'game' },
    { token: 'c', label: 'Close position', kind: 'game' },
  ])
  ok('a beat gets its own row, above the game\'s own buttons',
     mixed.inline_keyboard[0].map((b) => b.callback_data).join() === 'a,b' &&
     mixed.inline_keyboard.at(-1).map((b) => b.callback_data).join() === 'h,c',
     JSON.stringify(mixed.inline_keyboard.map((r) => r.map((b) => b.callback_data))))
}

// ---------------------------------------------------------------------------
section('stickers')
{
  const stills = readdirSync(ART).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  ok('there is art to send', stills.length > 0)

  const share = async (f) => {
    const i = await loadImage(f)
    const c = createCanvas(i.width, i.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(i, 0, 0)
    const px = ctx.getImageData(0, 0, i.width, i.height).data
    let ink = 0
    let clear = 0
    for (let j = 3; j < px.length; j += 4) {
      if (px[j] > 5) ink += 1
      if (px[j] < 250) clear += 1
    }
    const n = i.width * i.height
    return { ink: (100 * ink) / n, clear: (100 * clear) / n }
  }

  for (const f of stills) {
    const name = f.replace(/\.[^.]+$/, '')
    const file = artPath(name)
    const webp = await stickerOf(file)
    const img = await loadImage(webp)
    const long = Math.max(img.width, img.height)
    const short = Math.min(img.width, img.height)
    ok(`${name}: one side exactly 512, the other no more`,
       long === STICKER_SIDE && short <= STICKER_SIDE, `${img.width}x${img.height}`)
    ok(`${name}: it is a webp`, webp.subarray(8, 12).toString('ascii') === 'WEBP')
    // the empty-sticker bug is invisible to a dimension check; weight is the tell
    const got = await share(webp)
    const want = await share(file)
    ok(`${name}: still the same picture`, Math.abs(got.ink - want.ink) < 5,
       `${want.ink.toFixed(0)}% inked before, ${got.ink.toFixed(0)}% after, ${(webp.length / 1024).toFixed(1)}KB`)
    ok(`${name}: transparency survives`, Math.abs(got.clear - want.clear) < 5)
  }
  const one = artPath(stills[0].replace(/\.[^.]+$/, ''))
  ok('a second send reuses the conversion', (await stickerOf(one)) === (await stickerOf(one)))
  ok('a gif is an animation, a png is not', isAnimation('a.gif') && !isAnimation('a.png'))
  ok('a name with no file resolves to nothing', artPath('_nope_not_here') === null)
  ok('and a name that tries to escape the directory is refused', artPath('../../package') === null)
}

// ---------------------------------------------------------------------------
section('a conversation')
{
  const h = await harness()
  await say(h.bot, 'hello')
  ok('a stranger is walked in rather than erroring', h.sent.length > 0)
  ok('the opening art goes as a sticker, never a photo',
     h.sent.some((s) => s.method === 'sendSticker') && !h.sent.some((s) => s.method === 'sendPhoto'))
  ok('a sticker carries no caption', h.sent.filter((s) => s.method === 'sendSticker').every((s) => !s.payload.caption))
  ok('every message is HTML', msgs(h.sent).every((s) => s.payload.parse_mode === 'HTML'))
  ok('the typing indicator is raised', h.sent.some((s) => s.method === 'sendChatAction'))

  // The opening asks the player their name before it offers them anything,
  // and an ask has no choices on it - nothing to press is the whole of how a
  // player knows to answer it in their own words.
  ok('an ask sends no keyboard at all', h.sent.filter((s) => kbOf(s)).length === 0,
     `${h.sent.filter((s) => kbOf(s)).length}`)

  h.sent.length = 0
  await say(h.bot, 'OJS')
  const withKb = h.sent.filter((s) => kbOf(s))
  ok('exactly one message in the burst carries the keyboard', withKb.length === 1, `${withKb.length}`)
  ok('and it is the last thing sent',
     h.sent.filter((s) => s.method !== 'sendChatAction').at(-1) === withKb[0])
  ok('the opening offers the scene its choices', kbOf(withKb[0]).flat().length >= 1)

  h.sent.length = 0
  await say(h.bot, 'skip')
  ok('skip reaches the game', texts(h.sent).some((t) => /\*\*Day 1\*\*|Day 1/.test(t)))
  const kb = kbOf(h.sent.filter((s) => kbOf(s)).at(-1)).flat()
  ok('three worlds, an hour to spare and the workshop are offered',
     kb.filter((b) => /^[123]$/.test(b.callback_data)).length === 3 &&
     kb.some((b) => b.callback_data === 'wait') && kb.some((b) => b.callback_data === 'm'),
     JSON.stringify(kb.map((b) => b.callback_data)))

  h.sent.length = 0
  await tap(h.bot, '1')
  ok('a tap is a turn', h.sent.length > 0)
  ok('the callback is answered before the work', h.sent[0].method === 'answerCallbackQuery')
  ok('entering a world sends the chart as a photo', h.sent.some((s) => s.method === 'sendPhoto'))
  const photo = h.sent.find((s) => s.method === 'sendPhoto')
  ok('the chart travels on its own, with no caption under it', photo.payload.caption === undefined)
  ok('the report came first, as text', texts(h.sent).some((t) => /monopolisation/.test(t)))

  h.sent.length = 0
  for (const t of ['i', '250', '1', '5']) await say(h.bot, t)
  ok('a position can be opened by typing', texts(h.sent).some((t) => /Position open/.test(t)))
  const holdKb = kbOf(h.sent.filter((s) => kbOf(s)).at(-1)).flat().map((b) => b.callback_data)
  ok('hold and close are offered', holdKb.includes('h') && holdKb.includes('c'), holdKb.join())

  h.sent.length = 0
  await say(h.bot, 'h')
  ok('holding a step reports on a chart', h.sent.some((s) => s.method === 'sendPhoto'))
  h.sent.length = 0
  await say(h.bot, 'c')
  ok('closing settles and re-offers', texts(h.sent).some((t) => /Returns/.test(t)) && texts(h.sent).some((t) => /Three worlds are open/.test(t)))

  h.sent.length = 0
  await say(h.bot, 'nonsense that means nothing')
  ok('junk is nudged, not swallowed', texts(h.sent).length > 0)
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('/start, /restart and the commands')
{
  const h = await harness()
  await h.bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++updateId, date: 0, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }], chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'T' } },
  })
  ok('/start on a new chat plays the opening', h.sent.some((s) => s.method === 'sendSticker'))
  await enter(h.bot)
  for (const t of ['1', 'i', '500', '0', '5']) await say(h.bot, t)
  const before = (await h.host.store.load(sessionId('42'))).session
  ok('a game is under way', before.run !== null && before.balance === 500)

  h.sent.length = 0
  await h.bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++updateId, date: 0, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }], chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'T' } },
  })
  const after = (await h.host.store.load(sessionId('42'))).session
  ok('/start on an existing chat does NOT wipe it', after.run !== null && after.balance === 500)
  ok('it shows the standing instead', texts(h.sent).some((t) => /Status/.test(t)))

  h.sent.length = 0
  await h.bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++updateId, date: 0, text: '/restart', entities: [{ type: 'bot_command', offset: 0, length: 8 }], chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'T' } },
  })
  const wiped = (await h.host.store.load(sessionId('42'))).session
  ok('/restart throws the game away', wiped.run === null && wiped.balance === 1000 && wiped.rounds === 0)
  ok('and plays the opening again', h.sent.some((s) => s.method === 'sendSticker'))
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('two chats do not touch each other')
{
  const h = await harness()
  await say(h.bot, 'hi', 42); await enter(h.bot, 42)
  await say(h.bot, 'hi', 99); await enter(h.bot, 99)
  for (const t of ['1', 'i', '300', '0', '3']) await say(h.bot, t, 42)
  const a = (await h.host.store.load(sessionId('42'))).session
  const b = (await h.host.store.load(sessionId('99'))).session
  ok('one chat opens a position', a.run !== null && a.balance === 700)
  ok('the other is untouched', b.run === null && b.balance === 1000)
  ok('each chat has its own saved game', sessionId('42') !== sessionId('99'))
  ok('and a Telegram id cannot collide with a browser one', sessionId('42').startsWith('tg'))
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('a keyboard from four messages ago')
{
  // Telegram never retires a keyboard. The game's tokens are heavily reused -
  // `5` is a world, a stake and a holding depending on where you are - so a
  // stale tap is not inert, it is a different legal move.
  const h = await harness()
  await say(h.bot, 'hi')
  await enter(h.bot)
  await say(h.bot, '1')
  await say(h.bot, 'i')
  const before = h.game.summary((await h.host.store.load(sessionId('42'))).session)
  ok('the game is waiting for a stake', before.expect === 'stake')

  h.sent.length = 0
  await tap(h.bot, '5')          // a plausible holding, from an older keyboard
  const after = h.game.summary((await h.host.store.load(sessionId('42'))).session)
  ok('a stale tap does not move the game', after.expect === 'stake' && after.balance === before.balance,
     `${before.expect}/${before.balance} -> ${after.expect}/${after.balance}`)
  const answered = h.sent.find((s) => s.method === 'answerCallbackQuery')
  ok('the tap is answered with a reason rather than ignored',
     Boolean(answered?.payload?.text), JSON.stringify(answered?.payload))
  ok('and nothing at all is sent to the chat', !h.sent.some((s) => s.method === 'sendMessage'))

  h.sent.length = 0
  await tap(h.bot, '250')        // one that IS on the current keyboard
  const staked = h.game.summary((await h.host.store.load(sessionId('42'))).session)
  ok('a live tap still works', staked.expect === 'target')
  ok('and is answered without a complaint',
     !h.sent.find((s) => s.method === 'answerCallbackQuery')?.payload?.text)

  // typing is the player saying it on purpose, and stays unrestricted
  h.sent.length = 0
  await say(h.bot, '0')
  ok('typing is not held to the keyboard',
     h.game.summary((await h.host.store.load(sessionId('42'))).session).expect === 'holding')
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('every token Telegram will be asked to carry')
{
  const h = await harness()
  const seen = new Set()
  const check = async () => {
    const rec = await h.host.store.load(sessionId('42'))
    if (!rec) return
    for (const c of h.game.choices(rec.session)) {
      seen.add(`${rec.session.expect}:${c.token}`)
      const bytes = Buffer.byteLength(String(c.token))
      if (bytes < 1 || bytes > 64) ok(`token '${c.token}' is a legal callback payload`, false, `${bytes} bytes`)
      if (!c.kind) ok(`choice '${c.token}' says where it came from`, false, JSON.stringify(c))
    }
  }
  await say(h.bot, 'hi'); await check()
  await say(h.bot, 'OJS'); await check()
  await say(h.bot, 'skip'); await check()
  for (const t of ['m', 'b', '2', 'l', '1', 'o', 'i', '250', '1', '5', 'h', 'c']) {
    await say(h.bot, t)
    await check()
  }
  ok('every reachable button is 1 to 64 bytes and labelled', true, `${seen.size} distinct tokens across the walk`)
  ok('the walk actually reached several states', new Set([...seen].map((s) => s.split(':')[0])).size >= 5,
     [...new Set([...seen].map((s) => s.split(':')[0]))].join(','))
  await h.cleanup()
}

// ---------------------------------------------------------------------------
section('every line in copy.yaml survives the conversion')
{
  const copy = createCopy(COPY)
  const leaves = []
  const walk = (v) => {
    if (typeof v === 'string') leaves.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(COPY)
  const bad = []
  for (const raw of leaves) {
    const html = toHtml(raw)
    for (const tag of ['b', 'i', 'code']) {
      const open = (html.match(new RegExp(`<${tag}>`, 'g')) || []).length
      const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length
      if (open !== close) bad.push(`<${tag}> ${open}/${close} in: ${raw.slice(0, 60)}`)
    }
    if (/<(?!\/?(b|i|code)>)/.test(html)) bad.push(`stray angle bracket in: ${raw.slice(0, 60)}`)
  }
  ok(`all ${leaves.length} strings convert to balanced HTML`, bad.length === 0, bad.slice(0, 5).join('\n        '))

  // and the hostile answers a player could give an `ask` node
  for (const nasty of ['<b>x</b>', 'a`b', 'x_', '**bold**', '</i>', '&&&']) {
    const html = toHtml(`_Welcome, ${nasty}, to the desk._`)
    const balanced = ['b', 'i', 'code'].every((t) =>
      (html.match(new RegExp(`<${t}>`, 'g')) || []).length === (html.match(new RegExp(`</${t}>`, 'g')) || []).length)
    ok(`a player answering ${JSON.stringify(nasty)} cannot unbalance a line`, balanced, html)
  }
  ok('and cannot smuggle a tag through', !/<b>x<\/b>/.test(toHtml('<b>x</b>')))
  void copy
}

// ---------------------------------------------------------------------------
section('when Telegram says no')
{
  // transient: retried, and the turn survives
  let hits = 0
  const flaky = await harness({
    fail: (method) => {
      if (method !== 'sendMessage') return null
      hits += 1
      // fail the very first sendMessage twice, then behave
      if (hits <= 2) return Object.assign(new Error('socket hang up'), {})
      return null
    },
  })
  await say(flaky.bot, 'hello')
  ok('a transient failure is retried rather than losing the turn', hits > 2 && msgs(flaky.sent).length > 2, `${hits} attempts`)
  await flaky.cleanup()

  // permanent: not retried
  let perm = 0
  const blocked = await harness({
    fail: (method) => {
      if (method !== 'sendMessage') return null
      perm += 1
      return Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 })
    },
  })
  await say(blocked.bot, 'hello')
  ok('a blocked bot is not retried', perm === 1, `${perm} attempt(s)`)
  ok('and the process is still standing', true)
  await blocked.cleanup()

  // a chart that will not draw costs the picture, not the turn
  {
    const h = await harness()
    await say(h.bot, 'hi'); await enter(h.bot)
    h.sent.length = 0
    // an emission the renderer cannot draw: no series to plot
    const broken = { kind: 'traces', n: 2, holdings: ['AA', 'BB'], priced: null, f: null,
                     upto: 0, totalReadouts: 10, caption: 'AA @ 120G · +1.0%', title: 't' }
    await h.deliver(sessionId('42'), [broken], (await h.host.store.load(sessionId('42'))).session)
    ok('an undrawable chart still delivers its reading',
       texts(h.sent).some((t) => /120G/.test(t)) && !h.sent.some((s) => s.method === 'sendPhoto'))
    await h.cleanup()
  }

  // a delivery that fails must not lose an advanced turn
  const dir = await mkdtemp(join(tmpdir(), 'mw4-tg-lost-'))
  const warm = await harness({ seedDir: dir })
  await say(warm.bot, 'hello')      // the first message to a new chat only walks them in
  await enter(warm.bot)
  await say(warm.bot, '1')
  const at = (await warm.host.store.load(sessionId('42'))).session.world.readings.length
  const dead = await harness({ seedDir: dir, fail: (m) => (m === 'sendPhoto' ? Object.assign(new Error('nope'), { error_code: 403 }) : null) })
  await say(dead.bot, 'o')
  const now = (await dead.host.store.load(sessionId('42'))).session.world.readings.length
  ok('a turn whose delivery failed is still saved', now === at + 1,
     `world was at ${at} readouts, now ${now} — a lost save would replay the step`)
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
section('a game belongs to a person, not to a room')
// ---------------------------------------------------------------------------
{
  const h = await harness()
  await sayInGroup(h.bot, 'hello')
  ok('a group chat is not played', !(await h.host.store.load(sessionId('-100123'))))
  ok('and nobody in it is walked in either', !(await h.host.store.load(sessionId('7'))))
  ok('it is told why, once', texts(h.sent).length === 1 && /private chat/i.test(texts(h.sent)[0]),
     JSON.stringify(texts(h.sent)))
  await h.cleanup()
}
{
  // the id the Login Widget vouches for is the user id, so that is what a game
  // has to be saved under - see host/auth.mjs
  const h = await harness()
  await say(h.bot, 'hello', 5657145687)
  ok('a game is saved under the player, ready for the web client to find',
     Boolean(await h.host.store.load('tg5657145687')))
  await h.cleanup()
}

console.log(`\n  ${passes} passed${failures ? `, ${failures} FAILED` : ', all good'}\n`)
process.exit(failures ? 1 : 0)
