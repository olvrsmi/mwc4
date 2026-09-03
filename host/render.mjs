// render.mjs - a traces emission drawn as a PNG.
//
// The chart is the game: watching trajectories is the decision the player is
// asked to make, so it is drawn here, once, the same for every renderer, and
// handed over as bytes. The numbers stay on the emission for any renderer that
// would rather draw its own.
//
// Colours are the vim-bloomberg palette - the terminal's own amber over a set
// of saturated hues that stay apart from each other at phone size. Amber is
// reserved for the chrome and the holding you are actually in.
//
// Keep captions and labels to ASCII: the bundled font has no mathematical
// angle brackets or box-drawing glyphs, and renders them as tofu.

import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONTS = join(HERE, 'fonts')
for (const file of ['RobotoCondensed[wght].ttf', 'RobotoMono[wght].ttf']) {
  try { GlobalFonts.registerFromPath(join(FONTS, file)) } catch {
    console.warn(`  render: could not load ${file}; falling back to a system font`)
  }
}

const BG = '#000000'
const INK = '#F6F3E8'
const DIM = '#909090'
const LINE = '#202020'
const AMBER = '#F39000'
const QCOL = ['#FF6C60', '#A8FF60', '#96CBFE', '#FF73FD',
              '#E0C010', '#00A0A0', '#C6C5FE', '#E18964',
              '#0B85DF', '#B18A3D']
const qcol = (q) => QCOL[q % QCOL.length]
export const PALETTE = { bg: BG, ink: INK, dim: DIM, line: LINE, amber: AMBER, qubits: QCOL }

function pastel (hex, mix = 0.55) {
  const n = parseInt(hex.slice(1), 16)
  const to = (c) => Math.round(c + (255 - c) * mix)
  return `rgba(${to((n >> 16) & 255)},${to((n >> 8) & 255)},${to(n & 255)},.45)`
}

const MONO = '"Roboto Mono", "Courier New", monospace'
const SANS = '"Roboto Condensed", Arial, sans-serif'
const SCALE = 2
const WIDTH = 640
const SQUARE = 620

function frame (height, title, draw) {
  const canvas = createCanvas(WIDTH * SCALE, height * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, WIDTH, height)
  ctx.fillStyle = AMBER
  ctx.font = `bold 13px ${SANS}`
  ctx.textAlign = 'left'
  ctx.fillText(String(title || '').toUpperCase(), 14, 22)
  ctx.strokeStyle = AMBER
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, 32)
  ctx.lineTo(WIDTH, 32)
  ctx.stroke()
  draw(ctx, WIDTH, height)
  return canvas.toBuffer('image/png')
}

/**
 * Every holding's quote on one shared logarithmic axis: comparable, and a 2%
 * move is the same height wherever it happens. `priced` is the quote series;
 * `z` is the raw reading, a linear fallback for a caller without prices.
 */
export function renderTraces ({ n, z, priced, clean, upto, totalReadouts, target = null,
                                interventionAt = null, holdings, title, foot = {} }) {
  const series = priced || z
  const log = Boolean(priced)
  const name = (q) => holdings?.[q] ?? `E${q}`
  return frame(SQUARE, title, (ctx, W) => {
    const padL = 74, padR = 92, padT = 50, padB = 40
    const plotW = W - padL - padR
    const plotH = SQUARE - padT - padB
    const total = Math.max(1, totalReadouts - 1)
    const x = (k) => padL + (k / total) * plotW

    const flat = [...series.flat(), ...((clean && target !== null) ? clean.map((r) => r[target]) : [])]
      .filter((v) => Number.isFinite(v))
    let lo = Math.min(...flat), hi = Math.max(...flat)
    if (log) { lo /= 1.08; hi *= 1.08 } else { lo = Math.min(lo, -1); hi = Math.max(hi, 1) }
    if (!(hi > lo)) hi = lo + 1
    const y = log
      ? (v) => padT + plotH - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * plotH
      : (v) => padT + plotH - (v - lo) / (hi - lo) * plotH

    // the frame
    ctx.font = `11px ${MONO}`
    for (const v of log ? logTicks(lo, hi) : [-1, 0, 1]) {
      ctx.strokeStyle = LINE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, y(v))
      ctx.lineTo(padL + plotW, y(v))
      ctx.stroke()
      ctx.fillStyle = DIM
      ctx.textAlign = 'left'
      ctx.fillText(log ? Math.round(v).toLocaleString('en-GB') : v.toFixed(0), padL + 6, y(v) - 4)
    }

    // where the coupling was made, and everything after it
    if (interventionAt !== null) {
      ctx.fillStyle = 'rgba(243,144,0,.08)'
      ctx.fillRect(x(interventionAt), padT, x(total) - x(interventionAt), plotH)
      ctx.strokeStyle = AMBER
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x(interventionAt), padT)
      ctx.lineTo(x(interventionAt), padT + plotH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // what the holding would have done: dotted and washed out, a counterfactual
    if (clean && target !== null) {
      ctx.strokeStyle = pastel(qcol(target))
      ctx.lineWidth = 2
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      clean.forEach((row, k) => {
        const v = row[target]
        k ? ctx.lineTo(x(k), y(v)) : ctx.moveTo(x(k), y(v))
      })
      ctx.stroke()
      ctx.setLineDash([])
    }

    // the holdings, the held one last so it is never buried
    const order = [...Array(n).keys()].sort((a, b) => (a === target) - (b === target))
    for (const q of order) {
      const isTarget = q === target
      const line = series.map((row) => row[q])
      ctx.strokeStyle = qcol(q)
      ctx.lineWidth = isTarget ? 3 : 1.6
      ctx.globalAlpha = isTarget ? 1 : 0.9
      ctx.beginPath()
      line.forEach((v, k) => (k ? ctx.lineTo(x(k), y(v)) : ctx.moveTo(x(k), y(v))))
      ctx.stroke()
      ctx.fillStyle = qcol(q)
      line.forEach((v, k) => {
        ctx.beginPath()
        ctx.arc(x(k), y(v), isTarget ? 3 : 2, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
    }

    // labels, pushed apart so seven of them never overprint
    const label = (at) => order.map((q) => ({ q, at: at(q) })).sort((a, b) => a.at - b.at)
    const opens = label((q) => y(series[0][q]))
    spread(opens, 14, padT + 6, padT + plotH - 6)
    for (const l of opens) {
      const isTarget = l.q === target
      ctx.font = `${isTarget ? 'bold ' : ''}11px ${MONO}`
      ctx.textAlign = 'right'
      ctx.fillStyle = isTarget ? AMBER : qcol(l.q)
      ctx.fillText(name(l.q), padL - 8, l.y + 4)
    }
    const nows = label((q) => y(series[series.length - 1][q]))
    spread(nows, 15, padT + 6, padT + plotH - 6)
    for (const l of nows) {
      const isTarget = l.q === target
      const v = series[series.length - 1][l.q]
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.textAlign = 'left'
      ctx.fillStyle = isTarget ? AMBER : qcol(l.q)
      ctx.fillText(name(l.q), padL + plotW + 8, l.y + 4)
      ctx.fillStyle = isTarget ? AMBER : INK
      ctx.textAlign = 'right'
      ctx.fillText(log ? Math.round(v).toLocaleString('en-GB') : v.toFixed(3), W - 8, l.y + 4)
    }

    // the foot
    ctx.fillStyle = DIM
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'left'
    ctx.fillText(String(foot.left ?? 't0'), padL, SQUARE - 16)
    ctx.textAlign = 'right'
    ctx.fillText(String(foot.right ?? `t${total}`), padL + plotW, SQUARE - 16)
  })
}

/** Gridline values inside [lo, hi] on a 1/2/5-style ladder, never empty. */
function logTicks (lo, hi, most = 7) {
  const ladder = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]
  const all = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of ladder) {
      const v = m * Math.pow(10, e)
      if (v >= lo && v <= hi) all.push(v)
    }
  }
  all.sort((a, b) => a - b)
  if (!all.length) {
    const g = (f) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * f)
    return [g(0.15), g(0.5), g(0.85)].map((v) => Math.round(v))
  }
  if (all.length <= most) return all
  const step = Math.ceil(all.length / most)
  return all.filter((_, i) => i % step === 0)
}

/** Push sorted {at} apart so none are closer than `gap`, inside [min, max]. */
function spread (items, gap, min, max) {
  items.forEach((it) => { it.y = it.at })
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap
  }
  if (items.length && items[items.length - 1].y > max) {
    items[items.length - 1].y = max
    for (let i = items.length - 2; i >= 0; i--) {
      if (items[i + 1].y - items[i].y < gap) items[i].y = items[i + 1].y - gap
    }
  }
  items.forEach((it) => { it.y = Math.max(min, Math.min(max, it.y)) })
}

export const RENDERABLE = new Set(['traces'])

/** The one place an emission becomes a picture. */
export function renderEmission (e) {
  switch (e.kind) {
    case 'traces': return renderTraces(e)
    default: throw new Error(`renderEmission: nothing draws a '${e.kind}' emission`)
  }
}
