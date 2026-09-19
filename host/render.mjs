// render.mjs - a traces emission drawn as a PNG.
//
// The chart is the game: watching trajectories is the decision the player is
// asked to make, so it is drawn here, once, the same for every renderer, and
// handed over as bytes. The numbers stay on the emission for any renderer that
// would rather draw its own.
//
// The sheet is a dealing screen: 1024 x 544, black, ruled into 64px squares. A
// square is also one readout wide, so a market ages rightwards a square at a
// time and the player can count the steps off the paper without a time axis.
// The 64px columns at either edge carry the price ladder and are fenced off
// with a hairline; a title bar carries the three facts that do not fit on the
// grid. That is the whole of the furniture.
//
// Prices are on a LINEAR axis, so the ladder can be read in round numbers. The
// axis is set once, from the spread of the listing prices, and then left alone
// - a chart that rescales under the player is a chart that cannot be watched.
// It only ever coarsens, and only when a quote would otherwise fall off it.
//
// Keep captions and labels to ASCII: the bundled font has no mathematical
// angle brackets or box-drawing glyphs, and renders them as tofu.

import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONTS = join(HERE, 'fonts')
export const ART = join(HERE, 'art')

/**
 * The file behind an `art:` name, or null if there is none.
 *
 * A missing picture is not an error: a scene has to be writable before it is
 * drawn, so a name with no file plays as its line alone. The name is checked
 * against a strict pattern first, because it comes from copy.yaml and is about
 * to be joined onto a path.
 */
export function artPath (name) {
  if (!name || !/^[\w-]+$/.test(name)) return null
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    const file = join(ART, `${name}.${ext}`)
    if (existsSync(file)) return file
  }
  return null
}

// The three weights are static instances cut from RobotoMono[wght].ttf, which
// canvas cannot interpolate for itself: asking a variable font for 200 gets
// you 400, and asking it for bold gets you 400 smeared. They register as one
// family, so `200 17px "Roboto Mono"` picks the real ExtraLight.
for (const file of ['RobotoCondensed[wght].ttf', 'RobotoMono-ExtraLight.ttf',
                    'RobotoMono-Regular.ttf', 'RobotoMono-Bold.ttf']) {
  try { GlobalFonts.registerFromPath(join(FONTS, file)) } catch {
    console.warn(`  render: could not load ${file}; falling back to a system font`)
  }
}

// Everything below is in points, and the sheet is 1024 of them wide. It is
// drawn at SCALE device pixels to the point, because the chart is mostly read
// on a phone and a hairline ladder at 1x is a hairline nobody can see.
const SCALE = 2
const W = 1024
const BAR = 32                       // the title bar, rule included
const RULE = 2                       // and the rule that closes it
const PLOT = 512
const H = BAR + PLOT
const CELL = 64                      // the grid square, and one readout of width
const GUTTER = CELL                  // the price ladder at either edge
const X0 = GUTTER                    // the chart itself, between the fences
const X1 = W - GUTTER
const COLS = (X1 - X0) / CELL        // readouts a market can age through at full width
const ROWS = PLOT / CELL             // gridlines the ladder is cut into
const INSET = 20                     // title bar text, off the edge
const LADDER_PAD = 10                // a number, off its fence
const NAME_RIGHT = 48                // where a holding's name ends, above the numbers
const DOT = 6.5                      // the listing price, marked
const TRACE = 3                      // a quote's line
const CAP = 12                       // cap height of 17px Roboto Mono
const TIP = 11                       // the callout's point
const CALLOUT_H = 24

const BG = '#000000'
const INK = '#FFFFFF'
const GRID = 'rgba(255,255,255,.3)'  // a hairline drawn off-pixel: two rows of near-nothing
const COMPANY = ['#1FB448', '#FF0EAD', '#A0902C', '#679BBD',
                 '#8A77E3', '#7F7F7F', '#BD2235']
const colour = (q) => COMPANY[q % COMPANY.length]
export const PALETTE = { bg: BG, ink: INK, grid: GRID, companies: COMPANY }

const MONO = '"Roboto Mono"'
const LIGHT = `200 17px ${MONO}`     // every number on the sheet
const PLAIN = `17px ${MONO}`         // the title bar
const BOLD = `bold 17px ${MONO}`     // a holding's name

// Text is centred on a value, not sat on it: a name belongs beside its dot and
// a number beside its gridline, so the baseline is half a cap height below.
const baseline = (y) => Math.round(y + CAP / 2 + 0.5)
const TITLE_BASE = baseline((BAR - RULE) / 2)
const crisp = (v) => Math.round(v) + 0.5

const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)}%`

/**
 * The value between one gridline and the next: a 1/2/2.5/5 ladder, so whatever
 * the axis is asked for, the numbers down the side stay round.
 */
function niceStep (want) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(want, 1e-9))))
  for (const m of [1, 2, 2.5, 5]) if (m * e >= want - 1e-9) return m * e
  return 10 * e
}

const OPEN_FILL = 0.45   // how much of the height the listing prices take up
const OPEN_SIT = 0.4     // and how far up it they sit: room above to rise into
const FIT = 7 / 8        // the most a market may ever fill before the axis gives

/**
 * The price ladder: ROWS whole steps, so every gridline is a round number and
 * every grid square stays square.
 *
 * The step is what the opening spread asks for, which leaves the first readout
 * sitting in the middle of a chart with somewhere to go. It is only ever
 * revised upwards, and only to stop a quote falling off the sheet - a step
 * that changed with the wind would make two readouts incomparable, which is
 * the one thing the player is here to do.
 */
export function priceAxis (rows) {
  const finite = (xs) => xs.filter(Number.isFinite)
  const all = finite(rows.flat())
  const open = finite(rows[0] ?? [])
  if (!all.length) return { lo: 0, hi: ROWS, step: 1 }
  const lo = Math.min(...all), hi = Math.max(...all)
  const oLo = open.length ? Math.min(...open) : lo
  const oHi = open.length ? Math.max(...open) : hi
  // a world where nothing has moved yet still needs a ladder to hang on
  const spread = Math.max(oHi - oLo, (hi - lo) * OPEN_FILL, Math.abs(hi) * 0.02, 1e-6)
  const step = niceStep(Math.max(spread / OPEN_FILL, (hi - lo) / FIT) / ROWS)
  const span = step * ROWS
  // sit the opening spread OPEN_SIT of the way up, then snap to the step so the
  // gridlines keep their round numbers
  let base = Math.round(((oLo + oHi) / 2 - OPEN_SIT * span) / step) * step
  // a quote cannot be negative, so the ladder does not offer to price one. The
  // value factor can, and keeps its half of the axis.
  if (lo >= 0) base = Math.max(base, 0)
  // and it keeps half a step of air at each end, so a quote that has run away
  // from its listing price is still a line and not a crease along the edge.
  // FIT is what pays for that air: seven squares of market in eight of paper.
  const air = step / 2
  if (base > lo - air) base = Math.floor((lo - air) / step) * step
  if (base + span < hi + air) base = Math.ceil((hi + air) / step) * step - span
  return { lo: base, hi: base + span, step }
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

/**
 * What the title bar says on the right: the position, or that there isn't one.
 *
 * The change is a ratio of quotes, which only means anything on quotes. A
 * caller falling back to the value factor gets the holding's name and no
 * number, because a factor crosses zero and its ratio would be nonsense.
 */
function position (series, { target, interventionAt, at, name, quoted }) {
  if (target === null || target === undefined) return 'NO INVESTMENT'
  const from = series[Math.min(interventionAt ?? 0, at)]?.[target]
  const now = series[at]?.[target]
  if (!quoted || !Number.isFinite(from) || !Number.isFinite(now) || from <= 0) return name(target)
  return `${name(target)}: ${pct(now / from - 1)}`
}

/**
 * A number, the way its own ladder says it: as many places as the step between
 * two gridlines actually uses, and no more. Quotes land on whole G; the value
 * factor a caller without prices falls back to runs -1 to 1 and needs its
 * decimals, or every rung on the ladder would read zero.
 */
function rung (v, step) {
  const dot = String(step).indexOf('.')
  const places = dot < 0 ? 0 : Math.min(6, String(step).length - dot - 1)
  // `|| 0` collapses negative zero, which would otherwise print as "-0"
  return places ? v.toFixed(places) : (Math.round(v) || 0).toLocaleString('en-GB')
}

/**
 * Every holding's quote against one price ladder, a square to the readout.
 *
 * `priced` is the quote series; `f` is the value factor behind it, a linear
 * fallback for a caller without prices.
 */
export function renderTraces ({ n, f, priced, clean, upto, totalReadouts, target = null,
                                interventionAt = null, holdings, world, title,
                                market = 'NEO-MARKET', domain = null }) {
  const series = priced || f
  const at = Math.min(upto ?? series.length - 1, series.length - 1)
  const name = (q) => holdings?.[q] ?? `E${q}`
  const canvas = createCanvas(W * SCALE, H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  // a market ages one square per readout, and only compresses if it is going
  // to run off the end of the paper
  const steps = Math.max(1, (totalReadouts ?? series.length) - 1)
  const pitch = steps > COLS ? (X1 - X0) / steps : CELL
  const x = (k) => X0 + k * pitch
  const { lo, hi, step } = domain
    ? { lo: domain[0], hi: domain[1], step: (domain[1] - domain[0]) / ROWS }
    : priceAxis(series)
  const y = (v) => BAR + PLOT - ((v - lo) / (hi - lo)) * PLOT

  // ---- the paper ----------------------------------------------------------
  ctx.lineWidth = 1
  ctx.strokeStyle = GRID
  ctx.beginPath()
  for (let r = 0; r <= ROWS; r++) { ctx.moveTo(X0, BAR + r * CELL); ctx.lineTo(X1, BAR + r * CELL) }
  for (let c = 1; c < COLS; c++) { ctx.moveTo(X0 + c * CELL, BAR); ctx.lineTo(X0 + c * CELL, H) }
  ctx.stroke()

  ctx.strokeStyle = INK
  ctx.beginPath()
  ctx.moveTo(crisp(X0), BAR); ctx.lineTo(crisp(X0), H)
  ctx.moveTo(crisp(X1), BAR); ctx.lineTo(crisp(X1), H)
  ctx.stroke()

  // ---- the chart, kept off the title bar -----------------------------------
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, BAR, W, PLOT)
  ctx.clip()

  // where the coupling was made: everything right of it is a held position
  if (interventionAt !== null && interventionAt !== undefined && interventionAt > 0) {
    ctx.strokeStyle = INK
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(crisp(x(interventionAt)), BAR)
    ctx.lineTo(crisp(x(interventionAt)), H)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // what the holding would have done, had it been left alone
  if (clean && target !== null && target !== undefined && clean.length > 1) {
    ctx.strokeStyle = colour(target)
    ctx.globalAlpha = 0.4
    ctx.lineWidth = TRACE
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    clean.forEach((row, k) => (k ? ctx.lineTo(x(k), y(row[target])) : ctx.moveTo(x(k), y(row[target]))))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // the quotes, the held one last so it is never buried
  const order = [...Array(n).keys()].sort((a, b) => (a === target) - (b === target))
  ctx.lineWidth = TRACE
  ctx.lineJoin = 'round'
  ctx.lineCap = 'butt'
  for (const q of order) {
    ctx.strokeStyle = colour(q)
    ctx.beginPath()
    series.forEach((row, k) => (k ? ctx.lineTo(x(k), y(row[q])) : ctx.moveTo(x(k), y(row[q]))))
    ctx.stroke()
  }
  // the listing price, marked - the one point on the line the player was given
  // rather than found
  for (const q of order) {
    if (!Number.isFinite(series[0]?.[q])) continue
    ctx.fillStyle = colour(q)
    ctx.beginPath()
    ctx.arc(x(0), y(series[0][q]), DOT, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // ---- the ladder ---------------------------------------------------------
  ctx.font = LIGHT
  ctx.fillStyle = INK
  for (let r = 1; r < ROWS; r++) {
    const v = hi - r * step
    ctx.textAlign = 'right'
    // digits carry a pixel of side bearing, so right-aligned text needs a pixel
    // back to stand as far off its fence as the left-aligned column does
    ctx.fillText(rung(v, step), X0 - LADDER_PAD + 1, baseline(BAR + r * CELL))
    ctx.textAlign = 'left'
    ctx.fillText(rung(v, step), X1 + LADDER_PAD, baseline(BAR + r * CELL))
  }

  // ---- the names, over the ladder and never over each other ---------------
  const names = order
    .filter((q) => Number.isFinite(series[0]?.[q]))
    .map((q) => ({ q, at: y(series[0][q]) }))
    .sort((a, b) => a.at - b.at)
  spread(names, CAP + 3, BAR + CAP, H - CAP)
  ctx.font = BOLD
  ctx.textAlign = 'right'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2
  ctx.strokeStyle = BG
  for (const l of names) {
    ctx.strokeText(name(l.q), NAME_RIGHT, baseline(l.y))
    ctx.fillStyle = colour(l.q)
    ctx.fillText(name(l.q), NAME_RIGHT, baseline(l.y))
  }

  // ---- what the position is worth now -------------------------------------
  if (target !== null && target !== undefined && Number.isFinite(series[at]?.[target])) {
    callout(ctx, x(at), y(series[at][target]), rung(series[at][target], step))
  }

  // ---- the title bar ------------------------------------------------------
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, BAR)
  ctx.fillStyle = INK
  ctx.fillRect(0, BAR - RULE, W, RULE)
  ctx.font = PLAIN
  ctx.textAlign = 'left'
  ctx.fillText(String(world ?? title ?? '').toUpperCase(), INSET, TITLE_BASE)
  ctx.textAlign = 'center'
  ctx.fillText(`${market} | AGE: ${at} | SIZE: ${n}`, W / 2, TITLE_BASE)
  ctx.textAlign = 'right'
  ctx.fillText(position(series, { target, interventionAt, at, name, quoted: Boolean(priced) }),
               W - INSET, TITLE_BASE)

  return canvas.toBuffer('image/png')
}

/**
 * A quote, flagged where its line ends. It points back at the last reading, so
 * it reads as that holding's number and not as a caption on the chart.
 */
function callout (ctx, px, py, text) {
  ctx.font = LIGHT
  const w = Math.round(ctx.measureText(text).width) + 8
  const flip = px + TIP + w > W - 4
  const bx = flip ? px - TIP - w : px + TIP
  const by = Math.min(Math.max(py - CALLOUT_H / 2, BAR + 2), H - CALLOUT_H - 2)
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.lineTo(crisp(bx), crisp(by))
  ctx.lineTo(crisp(bx + w), crisp(by))
  ctx.lineTo(crisp(bx + w), crisp(by + CALLOUT_H))
  ctx.lineTo(crisp(bx), crisp(by + CALLOUT_H))
  ctx.closePath()
  ctx.fillStyle = BG
  ctx.fill()
  ctx.strokeStyle = INK
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.fillText(text, bx + w / 2, baseline(by + CALLOUT_H / 2))
}

export const RENDERABLE = new Set(['traces'])

/** The one place an emission becomes a picture. */
export function renderEmission (e) {
  switch (e.kind) {
    case 'traces': return renderTraces(e)
    default: throw new Error(`renderEmission: nothing draws a '${e.kind}' emission`)
  }
}
