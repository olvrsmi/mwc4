// fake-model.mjs - a deterministic stand-in for the physics.
//
// The game runs, the tests pass and the copy can be checked with no Python and
// no network. Trajectories are made up but behave the way the real ones do for
// the rules' purposes: they start polarised and wander, coupling drags the
// held holding and spends the apparatus, and the same world is the same world
// twice. Nothing here is physics.
//
// It speaks the same interface as the real backends:
//
//   worlds()                                -> [info]
//   step({ world, circuit, enter, couple }) -> { circuit, z, apparatus }
//
// `circuit` is whatever the backend needs to carry a run between steps. Here
// it is the fake's own state, which is why it is JSON and small.

import { hash32, mulberry } from './pricing.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const norm = (v) => Math.hypot(v[0], v[1], v[2])
const unit = (d) => { const n = norm(d); return n > 1e-9 ? d.map((x) => x / n) : [0, 0, 1] }

/** The clean reading of holding q after step k, in [-1, 1]. */
function trajectory (id, q, k) {
  const r = mulberry(hash32(`${id}:${q}`))
  const decay = 0.04 + 0.22 * r()
  const w = 0.5 + 1.8 * r()
  const phi = Math.PI * 2 * r()
  const floor = -0.5 + r()
  const e = Math.exp(-decay * k)
  return clamp(e * (0.55 + 0.45 * Math.cos(w * k + phi)) + (1 - e) * floor * 0.6, -1, 1)
}

/** Twelve invented worlds: enough variety for an offer of three to differ. */
export function syntheticWorlds (steps = 10) {
  const out = []
  const shapes = [[2, 'chain'], [3, 'ring'], [3, 'chain'], [4, 'ring'], [4, 'star'],
                  [5, 'chain'], [5, 'ring'], [6, 'star'], [7, 'ring'], [2, 'chain'],
                  [3, 'ring'], [4, 'chain']]
  shapes.forEach(([n, shape], i) => {
    const id = `fake_n${n}_${String(i + 1).padStart(2, '0')}`
    const pairs = []
    if (shape === 'ring') for (let q = 0; q < n; q++) pairs.push([q, (q + 1) % n].sort((a, b) => a - b))
    if (shape === 'chain') for (let q = 0; q + 1 < n; q++) pairs.push([q, q + 1])
    if (shape === 'star') for (let q = 1; q < n; q++) pairs.push([0, q])
    const uniq = [...new Map(pairs.map((p) => [p.join(','), p])).values()].sort()
    const words = 1 + (i % 3)
    const book = Array.from({ length: n }, (_, q) =>
      uniq.filter(([a, b]) => a === q || b === q).length * words)
    const ranges = Array.from({ length: n }, (_, q) => {
      const zs = Array.from({ length: steps }, (_, k) => trajectory(id, q, k))
      return +(Math.max(...zs) - Math.min(...zs)).toFixed(4)
    })
    out.push({
      id, n, pairs: uniq, max_pairs: n * (n - 1) / 2,
      constraints: uniq.length * words, book,
      components: [Array.from({ length: n }, (_, q) => q)], connected: true,
      readouts: steps,
      volatility: +(ranges.reduce((a, b) => a + b, 0) / n).toFixed(4),
      per_qubit_range: ranges,
      inert_qubits: ranges.map((x, q) => (x < 0.05 ? q : -1)).filter((q) => q >= 0),
    })
  })
  return out
}

/**
 * The fake. `worlds` may be the real specification list (from host/specs.mjs)
 * so offers match the other backends; the dynamics stay invented either way.
 */
export function createFakeModel ({ worlds = null, steps = 10, delayMs = 0 } = {}) {
  const list = worlds || syntheticWorlds(steps)
  const byId = new Map(list.map((w) => [w.id, w]))
  const calls = []

  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve())

  return {
    name: 'fake',
    calls,
    async worlds () {
      await wait()
      return list.map((w) => JSON.parse(JSON.stringify(w)))
    },
    async step ({ world, circuit = null, enter = null, couple = null }) {
      await wait()
      const info = byId.get(world)
      if (!info) throw new Error(`fake model: no world '${world}'`)
      calls.push({ world, k: circuit ? circuit.k : 0, enter: Boolean(enter), couple })
      const n = info.n
      const k = circuit ? circuit.k + 1 : 0
      const z = Array.from({ length: n }, (_, q) => trajectory(info.id, q, k))
      let app = circuit?.app ? [...circuit.app] : null
      if (enter) {
        const c = clamp(Number(enter.coherence ?? 1), 0, 1)
        app = unit(enter.direction || [0, 0, 1]).map((x) => x * c)
      }
      if (couple !== null && couple !== undefined) {
        if (!app) throw new Error('fake model: coupling with no apparatus in the circuit')
        const t = Number(couple)
        if (!(t >= 0 && t < n)) throw new Error(`fake model: holding ${couple} is outside ${world}'s ${n}`)
        // ZZ = 1 pulls the two Z's together: the holding toward the apparatus,
        // the apparatus toward the holding - and the coupling costs coherence.
        const m = 0.5 * norm(app)
        const zt = z[t]
        z[t] = clamp(zt * (1 - m) + app[2] * m, -1, 1)
        app[2] = app[2] * (1 - m) + zt * m
        app[0] *= 0.6
        app[1] *= 0.6
        app = app.map((x) => x * 0.82)
      }
      return { circuit: { k, app }, z, apparatus: app ? [...app] : null }
    },
  }
}
