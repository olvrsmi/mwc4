// app.js - the plainest possible renderer.
//
// Every emission is a bordered box. Text is a small markdown subset, a chart is
// the PNG the host rendered, art is a picture with its line. Choices become
// buttons, each sending the same token the player could have typed.
//
// It no longer knows which game it is playing. It used to keep an id in
// localStorage and send it with every request; the server keeps that now, in a
// cookie the page cannot read or edit, so what goes over the wire is only ever
// what the player did.

const $ = (id) => document.getElementById(id)
const log = $('log')
const choicesEl = $('choices')
const form = $('say')
const input = $('text')
const statusEl = $('status')
const resetBtn = $('reset')
const accountEl = $('account')

let busy = false
// What we last knew of the game, so a turn taken in Telegram is noticed when
// the player comes back to this tab.
let seen = null

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function md (s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    // an underscore inside a word (e_1) must not open or close emphasis
    .replace(/(^|[^\w`])_((?:[^_\n`]|_(?=\w))+)_(?![\w])/g, '$1<i>$2</i>')
    .replace(/\n/g, '<br>')
}

function box () {
  const div = document.createElement('div')
  div.className = 'msg'
  log.appendChild(div)
  return div
}

function render (e) {
  const div = box()
  if (e.kind === 'text') {
    div.innerHTML = (e.speaker ? `<b>${esc(e.speaker)}</b><br>` : '') + md(e.text || '')
  } else if (e.kind === 'art') {
    let html = e.url ? `<img src="${esc(e.url)}" alt="${esc(e.art)}"><br>` : `<small>[${esc(e.art)}]</small><br>`
    if (e.speaker) html += `<b>${esc(e.speaker)}</b><br>`
    if (e.text) html += md(e.text)
    div.innerHTML = html
  } else if (e.kind === 'traces') {
    let html = e.png ? `<img src="${esc(e.png)}" alt="${esc(e.title || 'chart')}"><br>` : `<small>[chart: ${esc(e.title || '')}]</small><br>`
    if (e.caption) html += md(e.caption)
    div.innerHTML = html
  } else {
    div.textContent = `[${e.kind}]`
  }
}

function echo (line) {
  const div = box()
  div.innerHTML = `<i>&gt; ${esc(line)}</i>`
}

function renderChoices (list) {
  choicesEl.innerHTML = ''
  for (const c of list || []) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = c.label
    b.onclick = () => say(c.token, c.label)
    choicesEl.appendChild(b)
    choicesEl.appendChild(document.createTextNode(' '))
  }
}

function renderStatus (s) {
  if (!s) { statusEl.textContent = ''; return }
  let line = `Day ${s.day} · step ${s.dayStep}/${s.daySteps} · budget ${s.budget}G · balance ${s.balance}G · coherence ${s.coherence}`
  if (s.bonus) line += ` · pot ${s.bonus}G`
  if (s.world) line += ` · in ${s.world.name} at t${s.world.readout}`
  if (s.position) line += ` · holding ${s.position.holding} (${s.position.stake}G)`
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

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/** The Login Widget, which will only render on the domain BotFather was told. */
function showLogin (botUsername) {
  accountEl.innerHTML = '<small>Playing as a guest. Sign in to carry this game on in Telegram.</small><br>'
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
    accountEl.innerHTML = `<small>${who}. This game is waiting for you in the chat too.</small> `
    const out = document.createElement('button')
    out.type = 'button'
    out.textContent = 'sign out'
    out.onclick = async () => {
      if (busy) return
      setBusy(true)
      try { show(await post('/api/auth/logout')) } finally { setBusy(false) }
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
  renderChoices([])
  const div = box()
  const line = (s) => `day ${s.day}, ${s.rounds} round${s.rounds === 1 ? '' : 's'} played, ` +
                      `balance ${s.balance}G` + (s.world ? `, in ${esc(s.world)}` : '')
  div.innerHTML =
    '<b>You already have a game in Telegram.</b><br>' +
    'Only one can carry on. The other is kept on the server, but you will not be able to reach it from here.<br><br>' +
    `<b>In Telegram:</b> ${line(choose.telegram)}<br>` +
    `<b>Here, as a guest:</b> ${line(choose.anonymous)}<br><br>`
  for (const [keep, label] of [['telegram', 'keep the Telegram game'], ['anonymous', 'keep this one']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.onclick = async () => {
      if (busy) return
      setBusy(true)
      try { show(await post('/api/auth/claim', { keep })) } catch (e) {
        box().textContent = `Could not finish signing in: ${e.message}`
      } finally { setBusy(false); scroll() }
    }
    div.appendChild(b)
    div.appendChild(document.createTextNode(' '))
  }
  scroll()
}

// The widget calls this by name, from its own iframe, so it has to be global.
window.onTelegramAuth = async (user) => {
  if (busy) return
  setBusy(true)
  try {
    const r = await post('/api/auth/telegram', { user })
    if (r.choose) return showChoice(r.choose)
    show(r)
  } catch (e) {
    box().textContent = `Could not sign in: ${e.message}`
  } finally {
    setBusy(false)
    scroll()
  }
}

function setBusy (on) {
  busy = on
  input.disabled = on
  for (const b of choicesEl.querySelectorAll('button')) b.disabled = on
}

const scroll = () => window.scrollTo(0, document.body.scrollHeight)

/** A whole standing, drawn from nothing. */
function show (r) {
  log.innerHTML = ''
  for (const e of r.log || []) render(e)
  renderChoices(r.choices)
  renderStatus(r.summary)
  showAccount(r)
  seen = mark(r)
}

async function boot (reset = false) {
  setBusy(true)
  try {
    show(await post(reset ? '/api/reset' : '/api/session'))
  } catch (e) {
    const div = box()
    div.textContent = `Could not reach the game: ${e.message}`
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
  if (busy || document.hidden) return
  try {
    const r = await post('/api/session')
    if (mark(r) === seen) return showAccount(r)
    show(r)
    scroll()
  } catch { /* offline, or the server is restarting: the next look will do */ }
}
document.addEventListener('visibilitychange', resync)
window.addEventListener('focus', resync)

async function say (token, label) {
  if (busy) return
  setBusy(true)
  echo(label && label !== token ? `${label}` : token)
  try {
    const r = await post('/api/say', { text: token })
    // the game this browser was in is gone; what came back is a whole new one
    if (r.reopened) return show(r)
    for (const e of r.emissions) render(e)
    renderChoices(r.choices)
    renderStatus(r.summary)
    seen = mark(r)
  } catch (e) {
    const div = box()
    div.textContent = `Something went wrong: ${e.message}`
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
