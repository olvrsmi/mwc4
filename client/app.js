// app.js - the plainest possible renderer.
//
// Every emission is a bordered box. Text is a small markdown subset, a chart is
// the PNG the host rendered, art is a picture with its line. Choices become
// buttons, each sending the same token the player could have typed.

const $ = (id) => document.getElementById(id)
const log = $('log')
const choicesEl = $('choices')
const form = $('say')
const input = $('text')
const statusEl = $('status')
const resetBtn = $('reset')

const KEY = 'mw4.session'
let sid = null
try { sid = localStorage.getItem(KEY) } catch { sid = null }
let busy = false

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
  if (s.position) line += ` · holding ${s.position.holding} (${s.position.stake}G) until t${s.position.exitAt}`
  if (s.probation) line += ` · probation, attempt ${s.attempts}`
  statusEl.textContent = line
}

async function post (path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

function setBusy (on) {
  busy = on
  input.disabled = on
  for (const b of choicesEl.querySelectorAll('button')) b.disabled = on
}

const scroll = () => window.scrollTo(0, document.body.scrollHeight)

async function boot (reset = false) {
  setBusy(true)
  try {
    const r = await post(reset ? '/api/reset' : '/api/session', { id: sid })
    sid = r.id
    try { localStorage.setItem(KEY, sid) } catch { /* private mode */ }
    log.innerHTML = ''
    for (const e of r.log) render(e)
    renderChoices(r.choices)
    renderStatus(r.summary)
  } catch (e) {
    const div = box()
    div.textContent = `Could not reach the game: ${e.message}`
  } finally {
    setBusy(false)
    scroll()
    input.focus()
  }
}

async function say (token, label) {
  if (busy) return
  setBusy(true)
  echo(label && label !== token ? `${label}` : token)
  try {
    const r = await post('/api/say', { id: sid, text: token })
    for (const e of r.emissions) render(e)
    renderChoices(r.choices)
    renderStatus(r.summary)
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
