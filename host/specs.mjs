// specs.mjs - the world specifications, read in JavaScript.
//
// A world is a JSON file in model/specs/: a set of targets the QDrive engine
// drives a circuit toward, every step. Its structure - how many holdings, which
// are wired to which, how heavily each is contracted - needs no physics, so it
// is worked out here and shared by every backend. Its character (how far the
// holdings actually move) does need the engine; that lives in
// specs/_stats_cache.json, written by model/warmcache.py.
//
// The arithmetic here mirrors model/engine.py's info_of() exactly, including
// the trap: QDrive follows qiskit's label convention, where the RIGHTMOST
// letter of a Pauli word is qubits[0].

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPEC_DIR = process.env.MW_SPEC_DIR ||
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'model', 'specs')

// zlib.crc32, so a hand-written specification without a seed gets the same
// seed here as it does in engine.py
const TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

export function crc32 (str) {
  let crc = -1
  for (const b of Buffer.from(String(str), 'utf8')) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** The seed that makes a world the same world twice. */
export const seedOf = (spec) => (spec.seed == null ? (crc32(spec.id) & 0x7fffffff) : Number(spec.seed))

/** The targets that are targets. A null entry flushes the queue; it drives nothing. */
export const realTargets = (spec) => (spec.targets || []).filter((t) => t !== null && t !== undefined)

export class Unusable extends Error {}

/** Check a specification enough to fail here, with a message a writer can use. */
export function validate (spec, id) {
  if (!spec || typeof spec !== 'object') throw new Unusable(`${id} is not an object`)
  if (spec.id !== undefined && spec.id !== id) throw new Unusable(`${id}: id '${spec.id}' does not match the filename`)
  if (!Array.isArray(spec.targets) || !spec.targets.length) throw new Unusable(`${id} has no targets`)
  if (spec.n === undefined) throw new Unusable(`${id} does not say how many qubits it has`)
  const n = Number(spec.n)
  if (!Number.isInteger(n) || n < 2) throw new Unusable(`${id} has n=${spec.n}; a target needs two qubits`)
  spec.targets.forEach((t, i) => {
    if (t === null) return
    const q = t.qubits
    if (!Array.isArray(q) || q.length !== 2) {
      throw new Unusable(`${id} target ${i} acts on ${JSON.stringify(q)}; targets take exactly two qubits`)
    }
    if (q.some((x) => !Number.isInteger(x) || x < 0 || x >= n)) {
      throw new Unusable(`${id} target ${i} names qubit(s) outside 0-${n - 1}: ${JSON.stringify(q)}`)
    }
  })
  return spec
}

/** Connected components of the target graph. */
export function componentsOf (n, pairs) {
  const adj = Array.from({ length: n }, () => new Set())
  for (const [a, b] of pairs) { adj[a].add(b); adj[b].add(a) }
  const seen = new Set()
  const out = []
  for (let q = 0; q < n; q++) {
    if (seen.has(q)) continue
    const comp = []
    const stack = [q]
    while (stack.length) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      comp.push(cur)
      for (const nb of adj[cur]) if (!seen.has(nb)) stack.push(nb)
    }
    out.push(comp.sort((a, b) => a - b))
  }
  return out
}

/** The structural facts the prospectus is built from. */
export function infoOf (spec, steps = 10) {
  const n = Number(spec.n)
  const targets = realTargets(spec)
  const pairs = [...new Map(targets.map((t) => {
    const p = [...t.qubits].sort((a, b) => a - b)
    return [p.join(','), p]
  })).values()].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const book = Array.from({ length: n }, (_, q) => {
    let count = 0
    for (const t of targets) {
      if (!t.qubits.includes(q)) continue
      const at = t.qubits.indexOf(q)
      for (const word of Object.keys(t.expvals || {})) {
        // rightmost letter is qubits[0]: word position k names qubits[len-1-k]
        if (word[word.length - 1 - at] !== 'I') count += 1
      }
    }
    return count
  })
  const components = componentsOf(n, pairs)
  return {
    id: spec.id,
    n,
    gates: targets.length * steps,
    depth: targets.length * steps,
    pairs,
    max_pairs: n * (n - 1) / 2,
    constraints: targets.reduce((a, t) => a + Object.keys(t.expvals || {}).length, 0),
    book,
    components,
    connected: components.length === 1,
    fraction: spec.fraction ?? null,
    readouts: steps,
  }
}

/**
 * Every specification in a directory, with its structure and, where the cache
 * has it, its character. Files starting with `_` are not worlds.
 */
export function loadSpecs ({ dir = SPEC_DIR, steps = 10, maxQubits = 7 } = {}) {
  const specs = new Map()
  const worlds = []
  const skipped = []
  const missingStats = []
  if (!existsSync(dir)) return { specs, worlds, skipped, missingStats, dir }

  let cache = {}
  const cachePath = join(dir, '_stats_cache.json')
  if (existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { cache = {} }
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
    const id = file.slice(0, -5)
    let spec
    try {
      spec = validate(JSON.parse(readFileSync(join(dir, file), 'utf8')), id)
    } catch (e) {
      skipped.push({ id, why: e.message })
      continue
    }
    spec.id = id
    spec.seed = seedOf(spec)
    if (spec.n > maxQubits) { skipped.push({ id, why: `out of range (n=${spec.n})` }); continue }
    specs.set(id, spec)
    const info = infoOf(spec, steps)
    const stats = cache[`${id}@${steps}`]
    if (stats) Object.assign(info, stats)
    else { missingStats.push(id); info.volatility = null; info.per_qubit_range = null; info.inert_qubits = [] }
    worlds.push(info)
  }
  return { specs, worlds, skipped, missingStats, dir }
}
