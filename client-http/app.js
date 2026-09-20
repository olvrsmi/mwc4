// app.js - the renderer.
//
// The page is one column. A picture takes the whole of it; everything said
// takes at most 380 of it and picks a side. The game talks down the LEFT,
// under a title bar naming whoever or whatever is talking - a speaker, or the
// heading over one of the game's own blocks. The player, and anything narrated
// about them, answers down the RIGHT with no title bar and only as wide as the
// words. Which side a line takes is the emission's own `voice`, set by the
// writer in copy.yaml: a scripted line about the player and a line of somebody
// else's narration are both text with no speaker on them, so this cannot be
// worked out here and does not try.
//
// It no longer knows which game it is playing. It used to keep an id in
// localStorage and send it with every request; the server keeps that now, in a
// cookie the page cannot read or edit, so what goes over the wire is only ever
// what the player did.
//
// A turn arrives as several emissions and they are shown one at a time, each
// waiting the milliseconds the game stamped on it. See core/pacing.mjs: the
// numbers are the copy editor's, and this only does the waiting.

const $ = (id) => document.getElementById(id)
const log = $('log')
const form = $('say')
const input = $('text')
const statusEl = $('status')
const resetBtn = $('reset')
const accountEl = $('account')
const dock = $('dock')

let busy = false
// What we last knew of the game, so a turn taken in Telegram is noticed when
// the player comes back to this tab.
let seen = null
// The row of buttons waiting to be answered, until one of them is.
let pending = null
// and what they stand for, so a token TYPED rather than clicked echoes as the
// same words the button would have - and as the same words the transcript
// keeps, so a reload does not rewrite what the player saw themselves say
let offered = []

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function md (s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    // an underscore inside a word (e_1) must not open or close emphasis
    .replace(/(^|[^\w`])_((?:[^_\n`]|_(?=\w))+)_(?![\w])/g, '$1<i>$2</i>')
    .replace(/\n/g, '<br>')
}

/** Whose side of the page a line belongs on. Unmarked is the game's. */
const sideOf = (v) => (v.voice === 'player' ? 'player' : 'game')

/**
 * What heads a message, or nothing.
 *
 * A speaker wins over a title: the name of whoever is talking says more than
 * the heading over what they said, and the tutorial's sections are the only
 * lines that carry both.
 */
const headOf = (v) => v.speaker || v.title || null

// ---------------------------------------------------------------------------
// An emission, as boxes
// ---------------------------------------------------------------------------

/**
 * One emission, as the one or two things it is drawn as.
 *
 * A scene node carrying a picture AND a line is a single emission - the writer
 * wrote one beat - but it is two boxes here, because a picture takes the width
 * and a line does not. They arrive a beat apart, so the picture lands and then
 * whoever is in it speaks; the second takes the same authored gap as the
 * first, since copy.yaml only ever wrote the one.
 */
function expand (e) {
  if (e.kind === 'art') {
    const picture = { view: 'art', art: e.art, url: e.url, delay: e.delay }
    if (!e.text && !e.speaker && !e.title) return [picture]
    return [picture, { view: 'text', text: e.text, speaker: e.speaker,
                       title: e.title, voice: e.voice, delay: e.delay }]
  }
  if (e.kind === 'traces') {
    const sheet = { view: 'chart', png: e.png, title: e.title, delay: e.delay }
    // The game sends charts without a caption - what one says is drawn on it -
    // but a writer who adds one gets it read out under the sheet.
    return e.caption ? [sheet, { view: 'text', text: e.caption, delay: e.delay }] : [sheet]
  }
  if (e.kind === 'text') return [{ ...e, view: 'text' }]
  // Only ever out of the transcript: a live turn has already resolved the
  // button that was clicked into this, and a reload has no button to resolve.
  if (e.kind === 'said') return [{ view: 'said', text: e.text, delay: 0 }]
  return [{ view: 'other', kind: e.kind, delay: e.delay }]
}

function messageBox (v) {
  const side = sideOf(v)
  const div = document.createElement('div')
  div.className = `msg ${side}`
  // the player's side is never headed: it is them, and they know
  const head = side === 'player' ? null : headOf(v)
  if (head) {
    const bar = document.createElement('div')
    bar.className = 'title'
    bar.textContent = head
    div.appendChild(bar)
  }
  const body = document.createElement('div')
  body.className = 'body'
  // trailing whitespace, trimmed: copy.yaml writes these as block scalars and
  // every one of them ends in a newline, which would otherwise draw as an
  // empty line inside the box
  body.innerHTML = md(String(v.text ?? '').replace(/\s+$/, ''))
  div.appendChild(body)
  return div
}

function imageBox (src, alt, { chart = false, full = null } = {}) {
  const div = document.createElement('div')
  div.className = chart ? 'shot chart' : 'shot'
  if (!src) {
    div.innerHTML = `<small class="missing">[${esc(alt)}]</small>`
    return div
  }
  const img = `<img src="${esc(src)}" alt="${esc(alt)}">`
  // a chart reduced to the column loses its ladder and its footer, so the
  // sheet it was drawn as is a click away
  div.innerHTML = full ? `<a href="${esc(full)}" target="_blank" rel="noopener">${img}</a>` : img
  return div
}

function draw (v) {
  let el
  if (v.view === 'art') el = imageBox(v.url, v.art)
  else if (v.view === 'chart') el = imageBox(v.png, v.title || 'chart', { chart: true, full: v.png })
  else if (v.view === 'text') el = messageBox(v)
  else if (v.view === 'said') { el = document.createElement('div'); el.appendChild(sayBox(v.text)) }
  else { el = document.createElement('div'); el.className = 'msg game'; el.textContent = `[${v.kind}]` }
  log.appendChild(el)
  return el
}

// ---------------------------------------------------------------------------
// Pacing
//
// A burst shown all at once is a wall of text, and a scene written as someone
// talking stops reading as someone talking. The gaps are authored in
// copy.yaml and travel on the emissions.
//
// A click anywhere in the log gives up the waiting and shows the rest at once.
// The timing is there for a first reading, not to hold anyone in it - and a
// player who has seen the opening before should not have to sit through it.
// ---------------------------------------------------------------------------

let skipping = false
let cutShort = null

function hurry () {
  skipping = true
  if (cutShort) cutShort()
}
log.addEventListener('click', hurry)

/** A wait that a click can end early. */
const pause = (ms) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); cutShort = null; resolve() }
  const timer = setTimeout(done, ms)
  cutShort = done
})

/** Someone is still talking. Removed when they do, on the side they will use. */
function typing (side) {
  const div = document.createElement('div')
  div.className = `typing ${side}`
  div.title = 'click to skip the wait'
  div.textContent = '…'
  log.appendChild(div)
  return div
}

/**
 * Emissions, one at a time.
 *
 * Nothing waits before the FIRST of a burst: that one is the answer to what
 * the player just did, and pausing on it reads as the page being slow rather
 * than as timing.
 */
async function renderBurst (emissions) {
  skipping = false
  const views = (emissions || []).flatMap(expand)
  for (let i = 0; i < views.length; i++) {
    const wait = i > 0 && !skipping ? Number(views[i].delay) || 0 : 0
    if (wait > 0) {
      const dots = typing(sideOf(views[i]))
      scroll()
      await pause(wait)
      dots.remove()
    }
    draw(views[i])
    scroll()
  }
  skipping = false
}

// ---------------------------------------------------------------------------
// Choices, and what a click leaves behind
// ---------------------------------------------------------------------------

/**
 * The buttons live in the transcript rather than under it.
 *
 * A choice is a thing that happened at a moment, so it is drawn at that moment
 * and stays there: taking one turns that row into the line it became, in the
 * space it was already occupying, and the next message arrives under it. A row
 * nobody answered - a resync, a reload - is simply removed.
 */
function renderChoices (list) {
  if (pending) { pending.remove(); pending = null }
  offered = list || []
  if (!list || !list.length) return
  const row = document.createElement('div')
  row.className = 'choices'
  for (const c of list) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn'
    b.textContent = c.label
    // a beat's token shadows a game command of the same name; a renderer that
    // wants to set the two apart has what it needs here
    if (c.kind) b.dataset.kind = c.kind
    b.onclick = () => say(c.token, c.label)
    row.appendChild(b)
  }
  log.appendChild(row)
  pending = row
}

/** What the player chose, as the box it is drawn in. */
function sayBox (line) {
  const said = document.createElement('div')
  said.className = 'echo'
  said.textContent = `> ${line}`
  return said
}

/** What the player just did, where they did it. */
function echo (line) {
  const said = sayBox(line)
  if (pending) {
    // the button that was taken, resolving into the answer it gave
    pending.className = ''
    pending.replaceChildren(said)
    pending = null
    return
  }
  const row = document.createElement('div')
  row.appendChild(said)
  log.appendChild(row)
}

function renderStatus (s) {
  if (!s) { statusEl.textContent = ''; return }
  let line = `Day ${s.day} · step ${s.dayStep}/${s.daySteps} · budget €$${s.budget} · balance €$${s.balance} · coherence ${s.coherence}`
  if (s.bonus) line += ` · pot €$${s.bonus}`
  if (s.world) line += ` · in ${s.world.name} at t${s.world.readout}`
  if (s.position) line += ` · holding ${s.position.holding} (€$${s.position.stake})`
  if (s.probation) line += ` · probation, attempt ${s.attempts}`
  statusEl.textContent = line
}

async function post (path, body = {}) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // the cookie is the whole of the request's claim about who is playing
    credentials: 'same-origin', body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

/**
 * Enough of the game's standing to notice it moved without us.
 *
 * The transcript is capped, so its length alone stops changing on a long game -
 * hence the rest, which keep moving for as long as anyone is playing.
 */
const mark = (r) => {
  const s = r.summary || {}
  return [r.logLength, s.day, s.dayStep, s.rounds, s.balance, s.expect].join('|')
}

/** Anything gone wrong, said where the game would have said it. */
function trouble (line) {
  const div = document.createElement('div')
  div.className = 'msg game'
  div.innerHTML = `<div class="body">${esc(line)}</div>`
  log.appendChild(div)
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/** The Login Widget, which will only render on the domain BotFather was told. */
function showLogin (botUsername) {
  accountEl.innerHTML = '<small>Playing as a guest. Sign in to carry this game on in Telegram.</small>'
  const s = document.createElement('script')
  s.async = true
  s.src = 'https://telegram.org/js/telegram-widget.js?22'
  s.setAttribute('data-telegram-login', botUsername)
  s.setAttribute('data-size', 'medium')
  s.setAttribute('data-userpic', 'false')
  s.setAttribute('data-request-access', 'write')
  s.setAttribute('data-onauth', 'onTelegramAuth(user)')
  accountEl.appendChild(s)
}

function showAccount (r) {
  accountEl.innerHTML = ''
  if (r.kind === 'telegram') {
    const who = r.name ? `Signed in as ${esc(r.name)}` : 'Signed in with Telegram'
    accountEl.innerHTML = `<small>${who}. This game is waiting for you in the chat too.</small><br>`
    const out = document.createElement('button')
    out.type = 'button'
    out.className = 'btn'
    out.textContent = 'sign out'
    out.onclick = async () => {
      if (busy) return
      setBusy(true)
      try { await show(await post('/api/auth/logout')) } finally { setBusy(false) }
    }
    accountEl.appendChild(out)
    return
  }
  if (r.canLogin && r.botUsername) showLogin(r.botUsername)
}

/**
 * Two games, one player: the one they have been playing here as a guest, and
 * one already under their name in Telegram. Neither is ours to throw away.
 */
function showChoice (choose) {
  log.innerHTML = ''
  pending = null
  const line = (s) => `day ${s.day}, ${s.rounds} round${s.rounds === 1 ? '' : 's'} played, ` +
                      `balance €$${s.balance}` + (s.world ? `, in ${esc(s.world)}` : '')
  const div = document.createElement('div')
  div.className = 'msg game'
  div.innerHTML =
    '<div class="title">You already have a game in Telegram</div>' +
    '<div class="body">' +
    'Only one can carry on. The other is kept on the server, but you will not be able to reach it from here.<br><br>' +
    `<b>In Telegram:</b> ${line(choose.telegram)}<br>` +
    `<b>Here, as a guest:</b> ${line(choose.anonymous)}` +
    '</div>'
  log.appendChild(div)

  const row = document.createElement('div')
  row.className = 'choices'
  for (const [keep, label] of [['telegram', 'keep the Telegram game'], ['anonymous', 'keep this one']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn'
    b.textContent = label
    b.onclick = async () => {
      if (busy) return
      setBusy(true)
      try { await show(await post('/api/auth/claim', { keep })) } catch (e) {
        trouble(`Could not finish signing in: ${e.message}`)
      } finally { setBusy(false); scroll() }
    }
    row.appendChild(b)
  }
  log.appendChild(row)
  scroll()
}

// The widget calls this by name, from its own iframe, so it has to be global.
window.onTelegramAuth = async (user) => {
  if (busy) return
  setBusy(true)
  try {
    const r = await post('/api/auth/telegram', { user })
    if (r.choose) return showChoice(r.choose)
    await show(r)
  } catch (e) {
    trouble(`Could not sign in: ${e.message}`)
  } finally {
    setBusy(false)
    scroll()
  }
}

function setBusy (on) {
  busy = on
  input.disabled = on
  for (const b of log.querySelectorAll('button')) b.disabled = on
}

const scroll = () => window.scrollTo(0, document.body.scrollHeight)

// The dock is pinned, so the column has to end above it rather than under it.
// Its height moves with the sign-in block and with how the buttons wrap.
const clearDock = () => { document.body.style.paddingBottom = `${dock.offsetHeight + 16}px` }
new ResizeObserver(clearDock).observe(dock)
clearDock()

/**
 * A whole standing, drawn from nothing.
 *
 * A game the server has just created is showing its opening for the first
 * time, so it is played. Every other standing - a reload, a resync, a login -
 * is a transcript that has already been read, and is redrawn at once.
 */
async function show (r) {
  log.innerHTML = ''
  pending = null
  if (r.fresh) await renderBurst(r.log)
  else for (const v of (r.log || []).flatMap(expand)) draw(v)
  renderChoices(r.choices)
  renderStatus(r.summary)
  showAccount(r)
  seen = mark(r)
}

// ---------------------------------------------------------------------------
// Reading a scene
//
// `?scene=probation_passed` plays one scene on its own, in a game the server
// keeps for the purpose - so the choices can be clicked and the pacing watched
// without playing the week that would otherwise be in the way. Nothing here
// touches the player's own game: take the query string off and reload, and it
// is where it was.
//
// The server only answers this when MW_PREVIEW is set, so on a deployment the
// route is not there at all and this quietly does nothing.
// ---------------------------------------------------------------------------
let previewing = null

async function preview (scene, vars = {}) {
  previewing = scene || null
  setBusy(true)
  try {
    if (!scene) {
      const { scenes } = await post('/api/preview', {})
      console.log(`mw.preview(<name>) - ${scenes.length} scenes:\n  ${scenes.join('\n  ')}`)
      return scenes
    }
    log.innerHTML = ''
    const r = await post('/api/preview', { scene, vars })
    await renderBurst(r.emissions)
    renderChoices(r.choices)
    renderStatus(r.summary)
  } catch (e) {
    previewing = null
    trouble(`Could not read '${scene}': ${e.message}`)
  } finally {
    setBusy(false)
    scroll()
  }
}

// `mw.preview('probation_failed')` re-runs without a reload, which matters
// because the server re-reads copy.yaml when it is saved: edit a line, run it
// again, and the change is on the screen.
window.mw = { preview, scenes: () => preview(null) }

async function boot (reset = false) {
  const wanted = new URLSearchParams(location.search).get('scene')
  if (wanted && !reset) return preview(wanted)
  previewing = null
  setBusy(true)
  try {
    await show(await post(reset ? '/api/reset' : '/api/session'))
  } catch (e) {
    trouble(`Could not reach the game: ${e.message}`)
  } finally {
    setBusy(false)
    scroll()
    input.focus()
  }
}

/**
 * Pick up anything that happened elsewhere.
 *
 * The same game can be played in Telegram, so a tab left open can be looking at
 * a week that has since moved on. Checking when the tab is looked at again is
 * enough - and it costs nothing when nothing has changed.
 */
async function resync () {
  // a scene being read is not a game that can have moved on elsewhere, and
  // resyncing would quietly put the player back in their own week
  if (busy || document.hidden || previewing) return
  try {
    const r = await post('/api/session')
    if (mark(r) === seen) return showAccount(r)
    await show(r)
    scroll()
  } catch { /* offline, or the server is restarting: the next look will do */ }
}
document.addEventListener('visibilitychange', resync)
window.addEventListener('focus', resync)

/** What a token is called, for a player who typed it instead of clicking it. */
function labelFor (token) {
  const t = String(token).trim().toLowerCase()
  const hit = offered.find((c) => String(c.token).toLowerCase() === t)
  return hit ? hit.label : token
}

async function say (token, label) {
  if (busy) return
  setBusy(true)
  echo(label && label !== token ? `${label}` : labelFor(token))
  scroll()
  try {
    const r = await post('/api/say', { text: token, preview: previewing })
    // the game this browser was in is gone; what came back is a whole new one
    if (r.reopened) return await show(r)
    await renderBurst(r.emissions)
    renderChoices(r.choices)
    renderStatus(r.summary)
    seen = mark(r)
  } catch (e) {
    trouble(`Something went wrong: ${e.message}`)
  } finally {
    setBusy(false)
    scroll()
    input.focus()
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault()
  const v = input.value.trim()
  if (!v) return
  input.value = ''
  say(v)
})

resetBtn.addEventListener('click', () => boot(true))

boot()
