// pricing.mjs - how a reading becomes a quote, and how a world is described.
//
// A holding is a listed company. What it is WORTH comes from its book of
// business - how many Pauli correlations in the specification name it, which is
// how many contracts it is held to, every step, forever. What it TRADES at is
// that worth divided by however many shares happened to be issued when it
// listed, which is a historical accident and carries no information at all.
//
// The quote moves as exp(-sigma * <Z>). Inverted, because a world starts
// polarised at <Z> ~ +1 and decoheres toward zero, so -<Z> is the direction
// that rises: a distressed book recovering. Multiplicative, so a quote is
// positive for every possible reading and needs no clamp, floor or special case.
//
// Only the picture depends on the listing price. A payout is
// stake x (1 + priceReturn(zIn, zOut)), a function of the readings alone.

export const DEFAULT_PRICE = {
  sigma: 0.5,     // how far a full swing of <Z> moves the quote
  unit: 90,       // G, the price of an empty book
  gamma: 0.35,    // how hard the book is compressed into a price
  spread: 1.3,    // widest the issued float pulls a quote either way
}

// `|| 0` collapses negative zero, which would otherwise print as "-0G"
export const money = (v) => `${(Math.round(v) || 0).toLocaleString('en-GB')}G`
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

/** A quote from a listing price and a reading. */
export function quote (base, z, P = DEFAULT_PRICE) {
  return base * Math.exp(-P.sigma * z)
}

/**
 * The return on a stake held from one reading to another. The base cancels, so
 * a cheap holding and a dear one pay the same for the same move - which is why
 * the quote cannot be used to pick a winner.
 */
export function priceReturn (zIn, zOut, P = DEFAULT_PRICE) {
  return Math.exp(P.sigma * (zIn - zOut)) - 1
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
