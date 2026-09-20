// pricing.mjs - how a reading becomes a quote, and how a world is described.
//
// A holding is a listed company. What it is WORTH comes from its book of
// business - how many Pauli correlations in the specification name it, which is
// how many contracts it is held to, every step, forever. What it TRADES at is
// that worth divided by however many shares happened to be issued when it
// listed, which is a historical accident and carries no information at all.
//
// A reading is a Bloch vector, [<X>, <Y>, <Z>], and the quote moves as
// exp(sigma * f) where f = (w . r)/|w| is that vector scored against the
// weights: growth (<Z>) and profitability (<X>) count for a holding, financial
// risk (<Y>) against. Dividing by |w| holds f in [-1, 1] - the range a single
// axis had - so sigma means the same thing as it did on one axis.
//
// It reads three axes because all three were already being measured. QDrive's
// single-qubit tomography returns X, Y and Z together; the engine was throwing
// two of them away and pricing from the third.
//
// NOT inverted. The old quote was exp(-sigma * <Z>), which rose as <Z> fell,
// because a world starts polarised at <Z> ~ +1 and decoheres toward zero and
// that was the only direction there was to rise in. f is signed the way the
// physics is, so a world that decoheres is now a world whose quotes fall
// unless <X> carries them - which re-scores every holding, and roughly inverts
// which ones look good.
//
// Still multiplicative, so a quote is positive for every possible reading and
// needs no clamp, floor or special case. Only the picture depends on the
// listing price: a payout is stake x (1 + priceReturn(rIn, rOut)), a function
// of the readings alone.

export const DEFAULT_PRICE = {
  sigma: 0.5,     // how far a full swing of the value factor moves the quote
  unit: 90,       // the price of an empty book
  gamma: 0.35,    // how hard the book is compressed into a price
  spread: 1.3,    // widest the issued float pulls a quote either way
  // What each axis is worth to a holding, over (<X>, <Y>, <Z>). Mirrored in
  // model/engine.py as WEIGHTS, which needs them to measure volatility on the
  // same quantity the quote moves on.
  weights: [1, -1, 1],
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Euro-dollars, the only unit the player is ever shown: a quote, a stake, a
// balance and an allowance are all counted in it. `|| 0` collapses negative
// zero, which would otherwise print as "€$-0".
export const money = (v) => `€$${(Math.round(v) || 0).toLocaleString('en-GB')}`
export const signedMoney = (v) => `${Math.round(v) > 0 ? '+' : ''}${money(v)}`
export const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)}%`
export const fmt3 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`

/** A small seeded generator; the same seed gives the same sequence anywhere. */
export function mulberry (a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 32-bit hash of a string, for anything that has to be stable forever. */
export function hash32 (s) {
  let h = 0
  for (const c of String(s)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return h
}

/** The listing price of holding q: what it trades at when <Z> is zero. */
export function basePrice (info, q, P = DEFAULT_PRICE) {
  const book = (info.book && info.book[q]) || 0
  // the float: stable for a world forever, drawn from the id so it needs no
  // storage and survives every restart
  const float = Math.exp((mulberry(hash32(`${info.id}:${q}`))() - 0.5) * 2 * Math.log(P.spread))
  return P.unit * Math.pow(1 + book, P.gamma) * float
}

/**
 * The scalar a quote is made of: a reading scored against the weights, in
 * [-1, 1]. Ported to model/engine.py as value_factor(), where it is what a
 * world's advertised volatility is measured on.
 *
 * Bounded twice over, and the second bound is the interesting one: f <= |r|,
 * the Bloch length, which shortens as a holding entangles. A densely wired
 * world cannot reach the extremes of its own price range, because the
 * information has moved into correlations this reading does not look at.
 */
export function valueFactor (r, P = DEFAULT_PRICE) {
  const [wx, wy, wz] = P.weights || DEFAULT_PRICE.weights
  const [x = 0, y = 0, z = 0] = r || []
  return clamp((wx * x + wy * y + wz * z) / (Math.hypot(wx, wy, wz) || 1), -1, 1)
}

/** A quote from a listing price and a reading. */
export function quote (base, r, P = DEFAULT_PRICE) {
  return base * Math.exp(P.sigma * valueFactor(r, P))
}

/**
 * The return on a stake held from one reading to another. The base cancels, so
 * a cheap holding and a dear one pay the same for the same move - which is why
 * the quote cannot be used to pick a winner.
 */
export function priceReturn (rIn, rOut, P = DEFAULT_PRICE) {
  return Math.exp(P.sigma * (valueFactor(rOut, P) - valueFactor(rIn, P))) - 1
}

/**
 * The technical facts of a world, said as a market would say them.
 *
 * The complexity words come from copy.yaml and the bands are derived from how
 * many there are, so a writer can add or remove one without touching thresholds.
 */
export function prospectus (copy, info) {
  const words = copy.list('vocabulary.complexity')
  const asked = info.constraints ?? 0
  const band = words.findIndex((_, i) => asked < 4 * Math.pow(1.45, i + 1))
  const complexity = words[band === -1 ? words.length - 1 : band] || 'unknown'
  const pairs = info.pairs || []
  const monopoly = Math.round(100 * pairs.length / Math.max(1, info.max_pairs || 1))
  const volatility = info.volatility == null ? '?' : Math.round(100 * info.volatility / 2)
  return { opportunities: info.n, complexity, monopoly, volatility }
}

/**
 * Each holding, said the way a market sheet says it.
 *
 * Three facts, and deliberately not a fourth. What it costs, how heavily it is
 * contracted, and who it is exposed to - all true, and none of them says how
 * far it will move. That figure exists (per_qubit_range) and is the answer to
 * the only question the player is really asking, so the sheet does not carry
 * it. It is found by watching, which is what the readouts are for.
 */
export function overview (copy, info, holdings, P = DEFAULT_PRICE) {
  const words = copy.list('vocabulary.contracted')
  const books = info.book || []
  return Array.from({ length: info.n }, (_, q) => {
    const book = books[q] || 0
    // An absolute ladder, not a within-world one: across the set a book runs
    // 0 to 12, and a light world should read as light.
    let i = words.findIndex((_, k) => book < 2 * Math.pow(1.75, k))
    if (i === -1) i = words.length - 1
    const wired = (info.pairs || [])
      .filter(([a, b]) => a === q || b === q)
      .map(([a, b]) => copy.holding(a === q ? b : a, holdings))
    const base = basePrice(info, q, P)
    return {
      holding: copy.holding(q, holdings),
      price: money(base),
      price_raw: base,
      contracted: words[i] || 'unknown',
      book_raw: book,
      exposure: wired.join(', '),
      exposed: wired.length > 0,
      exposure_count: wired.length,
    }
  })
}
