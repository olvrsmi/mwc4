// pacing.mjs - how long a message waits before it arrives.
//
// A turn can produce half a dozen messages at once. Delivered as fast as the
// wire allows they land in the same instant and read as a wall of text; the
// scene that was written as someone talking stops being someone talking. So
// every emission leaves the game carrying a `delay` in milliseconds, and a
// client waits that long before showing it.
//
// Two dials, both in copy.yaml under `pacing:` and both in SECONDS, because
// the person who sets them is the one writing the lines:
//
//   minimum:  the floor under every message, the game's own included
//   scene:    what a narrative node waits when it says nothing else
//
// A node may also carry its own `delay:`, and `pacing.scenes` may set a
// default per scene. The resolution is node, then scene, then `scene`, and
// whatever comes out is floored at `minimum` and capped at `max` - a floor
// called minimum that a line could duck under would not be one, and a cap is
// what keeps a writer's typo from parking the game for an hour.
//
// The delay is the gap BEFORE a message. The first message of a turn does not
// wait: it is the answer to what the player just did, and making that pause
// would read as lag rather than as timing.
//
// Pure, like everything else in core/: no clocks and no sleeping. This only
// says how long; the clients do the waiting.

/** Seconds. Overridden by `pacing:` in copy.yaml. */
export const DEFAULT_PACING = { minimum: 0.6, scene: 1.4, max: 20 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const toMs = (seconds) => Math.round(seconds * 1000)

// One reading per copy object. copy.yaml is re-read into a NEW copy on save,
// so an edit is picked up without this ever going stale.
const cache = new WeakMap()

/** Noted where every other copy problem is noted, so copy-check fails on it. */
function note (copy, message) {
  const problems = copy?.problems
  if (Array.isArray(problems) && !problems.includes(message)) problems.push(message)
}

/** A writer's number of seconds, or null when they did not give one. */
export function seconds (copy, value, where) {
  if (value === undefined || value === null) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) {
    note(copy, `pacing: ${where} is '${value}', which is not a number of seconds`)
    return null
  }
  return n
}

/** The `pacing:` block, validated, in milliseconds. */
export function readPacing (copy) {
  const hit = cache.get(copy)
  if (hit) return hit

  const raw = copy?.section ? copy.section('pacing') : undefined
  let spec = {}
  if (raw !== undefined) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) spec = raw
    else note(copy, "pacing: should be a mapping of 'minimum', 'scene', 'max' and 'scenes'")
  }

  const read = (name) => seconds(copy, spec[name], name) ?? DEFAULT_PACING[name]
  const max = read('max')
  const minimum = clamp(read('minimum'), 0, max)
  const scene = clamp(read('scene'), minimum, max)

  const scenes = {}
  if (spec.scenes !== undefined) {
    if (spec.scenes && typeof spec.scenes === 'object' && !Array.isArray(spec.scenes)) {
      for (const [id, value] of Object.entries(spec.scenes)) {
        const s = seconds(copy, value, `scenes.${id}`)
        if (s !== null) scenes[id] = toMs(clamp(s, minimum, max))
      }
    } else note(copy, 'pacing.scenes: should be a mapping of scene name to seconds')
  }

  const out = { minimum: toMs(minimum), scene: toMs(scene), max: toMs(max), scenes }
  cache.set(copy, out)
  return out
}

/**
 * What one narrative node waits: its own `delay:`, else its scene's, else the
 * `scene` default. `id` names the sequence or beat, for the per-scene lookup.
 */
export function sceneDelay (copy, id, node) {
  const P = readPacing(copy)
  const own = seconds(copy, node && typeof node === 'object' ? node.delay : undefined,
                      `${id || 'scene'}.delay`)
  if (own !== null) return clamp(toMs(own), P.minimum, P.max)
  if (id && P.scenes[id] !== undefined) return P.scenes[id]
  return P.scene
}

/**
 * Every emission of a turn, stamped.
 *
 * Whatever a scene authored is kept; everything else - the standing, a chart,
 * a prompt - takes the minimum, which is the whole of what stops a burst
 * arriving in one instant.
 */
export function withDelays (copy, emissions) {
  const P = readPacing(copy)
  return emissions.map((e) => {
    const authored = Number.isFinite(e?.delay) ? e.delay : P.minimum
    return { ...e, delay: clamp(Math.round(authored), P.minimum, P.max) }
  })
}
