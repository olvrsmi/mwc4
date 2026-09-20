// palette.mjs - audition company colours on a real chart.
//
//   node test/palette.mjs                  every set in PALETTES, stacked
//   node test/palette.mjs --out /tmp/pal   somewhere other than the scratch dir
//   node test/palette.mjs --seed 12        a different market
//   node test/palette.mjs --n 5 --steps 9  a smaller, shorter one
//
// It draws through host/render.mjs rather than reproducing it, so what comes
// out is the chart the game would send, not an impression of one. The market
// underneath is priced the way a real world is priced - basePrice and quote
// over a decohering reading - because colours that separate on a tidy sine
// wave do not necessarily separate on seven lines that cross.
//
// To try a set, add it to PALETTES. Nothing here is wired into the game: the
// market always draws with PALETTE.companies.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

import { renderTraces, PALETTE } from '../host/render.mjs'
import { basePrice, quote, mulberry } from '../core/pricing.mjs'
import { loadSpecs } from '../host/specs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const PALETTES = [
  { name: 'CURRENT', colours: PALETTE.companies },
  { name: 'SET 1', colours: ['#00FF00', '#FF00FF', '#FFFF00', '#0000FF', '#00FFFF', '#FF0000', '#AAAAAA'] },
]

const N = Number(arg('--n', 7))
const STEPS = Number(arg('--steps', 14))
const SEED = Number(arg('--seed', 42))
const OUT = arg('--out', join(ROOT, 'sim', 'palette'))
// a position, so the callout and the dashed line are in the picture too
const TARGET = Math.min(3, N - 1)
const OPENED = Math.min(4, STEPS)

/**
 * A market, priced the way the game prices one.
 *
 * The books come from a real specification, because what sets the holdings
 * apart at t0 is how heavily contracted each one is, and inventing that gets
 * the price levels - and so the axis - wrong. The reading starts polarised and
 * decoheres, which is what a world does, so the lines open close together and
 * fan out: the case where two colours have to be told apart, not the easy one.
 */
function market () {
  const real = Object.values(loadSpecs().worlds).find((w) => w.n === N)
  const info = real || { id: `palette-${SEED}`, n: N, book: Array.from({ length: N }, (_, q) => q) }
  const bases = Array.from({ length: N }, (_, q) => basePrice(info, q))
  const rnd = mulberry(SEED)
  let r = Array.from({ length: N }, () => [0.05, -0.05, 0.96].map((c) => c + (rnd() - 0.5) * 0.08))
  const rows = []
  for (let k = 0; k <= STEPS; k++) {
    rows.push(r.map((v, q) => quote(bases[q], v)))
    r = r.map((v) => v.map((c) => Math.max(-1, Math.min(1, c * 0.93 + (rnd() - 0.5) * 0.3))))
  }
  return { rows, id: info.id }
}

const TICKERS = ['AAA', 'BRG', 'CND', 'DLT', 'EMR', 'FTH', 'GRV', 'HZL', 'IVY', 'JMB']
const { rows: priced, id } = market()
const holdings = TICKERS.slice(0, N)

mkdirSync(OUT, { recursive: true })
const shots = []
for (const [i, p] of PALETTES.entries()) {
  const png = renderTraces({
    n: N, priced, upto: STEPS, totalReadouts: STEPS + 1, target: TARGET,
    interventionAt: OPENED, holdings, world: p.name, colours: p.colours,
  })
  const file = join(OUT, `palette-${String(i + 1).padStart(2, '0')}.png`)
  writeFileSync(file, png)
  shots.push({ ...p, file })
  console.log(`  ${p.name.padEnd(10)} ${p.colours.join(' ')}\n             ${file}`)
}

// one sheet, each chart under the swatches it was drawn with
const CH = 576, HEAD = 44
const sheet = createCanvas(1024, (CH + HEAD) * shots.length)
const ctx = sheet.getContext('2d')
ctx.fillStyle = '#181818'
ctx.fillRect(0, 0, sheet.width, sheet.height)
let y = 0
for (const s of shots) {
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 15px "Roboto Mono"'
  ctx.fillText(s.name, 14, y + 27)
  s.colours.forEach((c, k) => {
    const x = 300 + k * 100
    ctx.fillStyle = c
    ctx.fillRect(x, y + 11, 92, 15)
    ctx.fillStyle = '#AAAAAA'
    ctx.font = '11px "Roboto Mono"'
    ctx.fillText(c, x, y + 39)
  })
  y += HEAD
  ctx.drawImage(await loadImage(s.file), 0, y, 1024, CH)
  y += CH
}
const sheetFile = join(OUT, 'compare.png')
writeFileSync(sheetFile, sheet.toBuffer('image/png'))
console.log(`\n  ${N} holdings over ${STEPS} steps on ${id}, holding ${holdings[TARGET]} from t${OPENED}, seed ${SEED}`)
console.log(`  compare    ${sheetFile}`)
