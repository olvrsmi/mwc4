// copy.mjs - every player-facing word lives in copy.yaml; this renders it.
//
// Pure. It takes the parsed YAML as a plain object and knows nothing about
// files: the host reads copy.yaml (and re-reads it when a writer saves) and
// hands the object in. Values in a context arrive ALREADY FORMATTED -
// {coherence} is the string "0.999", not a float - so ordinary lines need no
// syntax beyond the braces. Filters, conditionals and plurals exist for when
// prose needs to bend, not as the usual way to write a line.
//
//   {balance}                          a value, formatted by the engine
//   {balance_raw|money}                a filter, when the default is not wanted
//   {count} opportunit{count|s:y:ies}  the plural escape hatch
//   {#if recovering} (…){/if}          a conditional
//   {#if x}a{:else}b{/if}              with an alternative
//
// Nothing here can stop a turn. A missing key, a bad filter or an unclosed
// conditional renders something visible and is noted in `problems`.

const FILTERS = {
  '3dp': (v) => Number(v).toFixed(3),
  '4dp': (v) => Number(v).toFixed(4),
  '1dp': (v) => Number(v).toFixed(1),
  round: (v) => String(Math.round(Number(v))),
  money: (v) => `${(Math.round(Number(v)) || 0).toLocaleString('en-GB')}G`,
  pct: (v) => `${Number(v) >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`,
  signed: (v) => `${Number(v) >= 0 ? '+' : ''}${Number(v)}`,
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  // {count|s:opportunity:opportunities}
  s: (v, one, many) => (Number(v) === 1 ? one : many),
}

export const filterNames = () => Object.keys(FILTERS)

const truthy = (v) => !(v === undefined || v === null || v === false || v === '' || v === 0)

/**
 * Build a copy object from parsed YAML.
 *
 * `random` is injectable so a test can make "one line at random" predictable.
 */
export function createCopy (source = {}, { random = Math.random } = {}) {
  if (!source || typeof source !== 'object') source = {}
  const problems = []
  // key -> the context names it has been rendered with. copy-check turns this
  // on to test every {placeholder} against what the game actually supplies.
  const recorded = new Map()
  let recording = false

  const note = (m) => { if (!problems.includes(m)) problems.push(m) }
  const lookup = (key) =>
    String(key).split('.').reduce((o, k) => (o == null ? undefined : o[k]), source)

  const has = (key) => lookup(key) !== undefined
  /** The raw value at a key: an object, an array, a string - unrendered. */
  const section = (key) => lookup(key)

  /** A list of variants, for anything the writer may supply several phrasings of. */
  function list (key) {
    const v = lookup(key)
    if (Array.isArray(v)) return v
    if (typeof v === 'string') return [v]
    if (v !== undefined) note(`copy: ${key} should be a list`)
    return []
  }

  function missing (key) {
    note(`copy: no entry for '${key}'`)
    return `[missing copy: ${key}]`
  }

  function applyFilter (value, spec, key) {
    const [name, ...args] = spec.split(':')
    const fn = FILTERS[name]
    if (!fn) { note(`copy: '${key}' uses unknown filter '${name}'`); return value }
    try { return fn(value, ...args) } catch { note(`copy: filter '${name}' failed in '${key}'`); return value }
  }

  /** Resolve {#if x}…{:else}…{/if}, innermost first so nesting works. */
  function conditionals (tpl, ctx, key) {
    const re = /\{#if\s+([\w.]+)\}((?:(?!\{#if\s)[\s\S])*?)\{\/if\}/
    let out = tpl
    let guard = 0
    while (re.test(out) && guard++ < 50) {
      out = out.replace(re, (_, name, body) => {
        const [whenTrue, whenFalse = ''] = body.split('{:else}')
        if (!(name in ctx)) note(`copy: '${key}' tests '${name}', which is not supplied`)
        return truthy(ctx[name]) ? whenTrue : whenFalse
      })
    }
    if (out.includes('{#if')) note(`copy: '${key}' has an unclosed {#if}`)
    return out
  }

  /** Fill {name} and {name|filter:args}. */
  function interpolate (tpl, ctx, key) {
    return tpl.replace(/\{([\w.]+)((?:\|[^}]*)?)\}/g, (whole, name, filterPart) => {
      if (!(name in ctx)) { note(`copy: '${key}' uses {${name}}, which is not supplied`); return whole }
      let value = ctx[name]
      for (const spec of filterPart.split('|').filter(Boolean)) value = applyFilter(value, spec, key)
      return String(value)
    })
  }

  /** Render a template string against a context. */
  function render (tpl, ctx = {}, key = '(inline)') {
    if (typeof tpl !== 'string') return missing(key)
    return interpolate(conditionals(tpl, ctx, key), ctx, key).trimEnd()
  }

  /** One variant of a list, at random. */
  function pick (key, ctx = {}) {
    const options = list(key)
    if (!options.length) return missing(key)
    return render(options[Math.floor(random() * options.length)], ctx, key)
  }

  /** The main entry point: look a key up and render it. */
  function t (key, ctx = {}) {
    if (recording) {
      if (!recorded.has(key)) recorded.set(key, new Set())
      for (const k of Object.keys(ctx)) recorded.get(key).add(k)
    }
    const tpl = lookup(key)
    if (tpl === undefined) return missing(key)
    if (Array.isArray(tpl)) return pick(key, ctx)
    return render(tpl, ctx, key)
  }

  /**
   * The two things the game names over and over: a holding within a world and
   * a moment in its progress. Everything that writes "PBP" or "t7" goes
   * through these, so the writer renames them in one place.
   */
  const holding = (index, names) => names?.[index] ?? t('vocabulary.holding', { index })
  const moment = (index) => t('vocabulary.moment', { index })

  /** Every leaf key, dotted, sorted. */
  function allKeys () {
    const out = []
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o || {})) {
        const key = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key)
        else out.push(key)
      }
    }
    walk(source, '')
    return out.sort()
  }

  return {
    t, list, pick, has, section, render, holding, moment, allKeys,
    problems, recorded, filterNames,
    record (on = true) { recording = on },
    source,
  }
}
