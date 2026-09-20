// story.mjs - the narrative: scripted scenes and the beats of the week.
//
// Everything here reads copy.yaml and writes only to the session. No clocks, no
// I/O, no renderer: a scene is a list of nodes a writer authored, and this plays
// them a node at a time, stopping wherever one wants something from the player.
//
// SEQUENCES (copy.yaml `sequences:`) have the floor while they run. A node may
// carry `art`, `speaker`, `text`, `choices` (keyed a, b, c... any number) and
// `ask` (capture what they type into a named variable, clamped to the node's
// `max` characters). Choices colour the moment and rejoin: the reply plays,
// then the scene carries on. There is no branching to track.
//
// A node may also say who is talking and what heads the line: `voice: player`
// for a line spoken by or about the player, and `title:` for a heading over
// it. Both are for renderers that draw those distinctions - the browser puts
// the player's lines down the other side of the page - and both are ignored by
// one that does not. A choice may carry either, for its reply.
//
// BEATS (copy.yaml `beats:`) are setpieces keyed to a day of the probation
// week. One fires once ever when its day begins. A beat with choices leaves
// itself pending; it never interrupts anything, and a command that is not one
// of its choices reaches the game untouched.
//
// Both may carry two effects, on a choice or on the node: `coherence:` as a
// delta on the player's qubit, and `unlock:` as an id noted for later.
//
// Both may also carry `delay:`, in seconds - how long that line waits before
// it arrives. See pacing.mjs; the number is resolved here, where the node is,
// and the waiting is a client's job.

import { money } from './pricing.mjs'
import { sceneDelay } from './pacing.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** The context every line in a scene can read. */
export function seqCtx (S) {
  return {
    ...S.vars,
    budget: money(S.budget),
    coherence: S.coherence.toFixed(3),
    // Last, so a scene handed its own facts wins. They ride on S.seq rather
    // than S.vars because they belong to this playing of the scene.
    ...(S.seq && S.seq.vars),
  }
}

/**
 * One node as emissions. A picture carries its line; a renderer decides how.
 *
 * `id` names the scene, for the per-scene pacing default. `pace: false` is for
 * lines read back rather than performed - see `narrate` - and takes no timing
 * with it, so they fall to the minimum every message gets.
 */
function nodeEmit (copy, S, node, tpl, { id = S.seq?.id ?? null, pace = true } = {}) {
  const ctx = seqCtx(S)
  const body = typeof tpl === 'string' ? copy.render(tpl, ctx, `sequences.${id ?? '?'}`) : null
  const speaker = node.speaker ? copy.render(String(node.speaker), ctx) : null
  const timing = pace ? { pace: true, delay: sceneDelay(copy, id, node) } : { pace: false }
  const marks = { ...voiceOf(node), ...titleOf(copy, ctx, node) }
  if (node.art) return [{ kind: 'art', art: String(node.art), speaker, text: body, ...marks, ...timing }]
  return body === null ? [] : [{ kind: 'text', speaker, text: body, ...marks, ...timing }]
}

/**
 * Who a line belongs to, when the writer has said.
 *
 * A renderer that sets the two apart - the browser puts the player's side of
 * the page opposite the game's - cannot tell them apart on its own: a scripted
 * line about the player and a line of somebody else's narration are both text
 * with no speaker on them. So `voice: player` is the writer's to set, and
 * anything unmarked is the game talking, which is nearly everything.
 */
const voiceOf = (spec) => (spec && spec.voice ? { voice: String(spec.voice) } : {})

/**
 * A line's heading, when it has one.
 *
 * `title:` is set beside the text it heads, for a node that is a block rather
 * than somebody talking. A speaker is a heading too - it is the name over a
 * line of dialogue - and a node carrying both shows the SPEAKER: who is
 * talking says more than the heading over what they said.
 */
const titleOf = (copy, ctx, spec) =>
  (spec && spec.title ? { title: copy.render(String(spec.title), ctx) } : {})

/** A beat's one line, timed the way a scene's node is. */
const beatLine = (copy, id, spec, body) =>
  ({ kind: 'text', text: body, pace: true, delay: sceneDelay(copy, id, spec),
     ...voiceOf(spec) })

/**
 * Whatever the player typed, made safe to drop into a writer's line.
 *
 * A renderer converts a small markdown subset delimited by ` * _, and the
 * answer to an `ask` is interpolated straight into sentences that use it. A
 * player cannot inject anything - a renderer escapes before it converts - but
 * a stray delimiter swallows the emphasis around it, so the author's line
 * loses its formatting or keeps a loose underscore on screen. Stripped here,
 * at the one place a player's own words enter the copy, rather than in every
 * renderer that has to render them.
 *
 * So are the characters that are not characters: a control code, and a
 * formatting one such as a right-to-left override, which is invisible and
 * reorders every line it is dropped into. Runs of whitespace close up behind
 * them, so what comes back is one line however many the player sent.
 *
 * `max` is the writer's, set beside the `ask` in copy.yaml - initials want
 * seven, a sentence wants the sixty every answer gets by default. Sliced by
 * code point, so an answer made of emoji cannot be cut through the middle of
 * a surrogate pair and left as a broken half in the saved game.
 */
export const capture = (raw, max = 60) =>
  [...String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')]
    .slice(0, Math.max(1, Math.round(Number(max) || 60)))
    .join('')
    .trim()

/** Apply a node's or a choice's effects. Only two things a beat may touch. */
export function applyEffects (S, spec) {
  if (!spec || typeof spec !== 'object') return
  if (typeof spec.coherence === 'number') S.coherence = clamp(S.coherence + spec.coherence, 0, 1)
  if (spec.unlock) S.unlocked = [...new Set([...(S.unlocked || []), String(spec.unlock)])]
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

const seqNodes = (copy, S) => (S.seq && copy.section(`sequences.${S.seq.id}`)) || []

export const inSequence = (S) => Boolean(S.seq)

/** Begin a named scene. An empty or unknown scene plays nothing and is over. */
export function startSequence (copy, S, id, vars = null) {
  const nodes = copy.section(`sequences.${id}`)
  if (!Array.isArray(nodes) || !nodes.length) return []
  S.seq = { id, at: 0, awaiting: null, ...(vars ? { vars } : {}) }
  S.vars ??= {}
  return runSequence(copy, S)
}

/**
 * Play forward until the scene wants something, or ends. Everything between
 * stops goes at once; `awaiting` says what the next message will mean.
 */
export function runSequence (copy, S) {
  const out = []
  const nodes = seqNodes(copy, S)
  while (S.seq && S.seq.at < nodes.length) {
    const node = nodes[S.seq.at] || {}
    out.push(...nodeEmit(copy, S, node, node.text))
    if (node.choices && typeof node.choices === 'object') { S.seq.awaiting = 'choice'; return out }
    if (node.ask) { S.seq.awaiting = 'ask'; return out }
    S.seq.at += 1
  }
  endSequence(S)
  return out
}

/** The scene is over; hand back to the game. */
export function endSequence (S) {
  if (!S.seq) return
  S.seqSeen = [...new Set([...(S.seqSeen || []), S.seq.id])]
  S.seq = null
  S.expect = 'boot'
}

/**
 * A scene's lines, said again, without entering it. Touches nothing the game
 * runs on, so the scene it names must not stop to ask anything.
 */
export function narrate (copy, S, id) {
  const nodes = copy.section(`sequences.${id}`)
  if (!Array.isArray(nodes)) return []
  // Unpaced, deliberately. A scene is performed a beat at a time because
  // someone is talking; this is the same words read back on request, and a
  // player who asks how the game works should not wait out the dramatic
  // timing to be told. They still arrive one at a time - the minimum under
  // every message is not dramatic timing, it is not sending six at once.
  return nodes.flatMap((node) => nodeEmit(copy, S, node || {}, node?.text, { id, pace: false }))
}

/**
 * Is the running scene waiting on something the player has to type?
 *
 * Asked by the one caller that has to know the difference: a scene stopped on
 * a choice can be skipped past, and a scene stopped on an `ask` cannot - the
 * answer is the player's own and the game carries it from there, so there is
 * nothing sensible to skip it with. Read off the node, like everything else
 * here that could be wrong about what is on offer.
 */
export function awaitingAsk (copy, S) {
  if (!S.seq) return false
  const node = seqNodes(copy, S)[S.seq.at] || {}
  return Boolean(node.ask) && !node.choices
}

/**
 * The choices a scene is waiting on, or none - an `ask` has none, and is
 * answered in the player's own words.
 *
 * Read off the node rather than off `awaiting`, for the reason answerSequence
 * does: the two have to agree about what is on offer, and the node is what
 * either of them would be wrong about.
 */
export function sequenceChoices (copy, S) {
  if (!S.seq) return []
  const node = seqNodes(copy, S)[S.seq.at] || {}
  if (!node.choices || typeof node.choices !== 'object') return []
  return Object.entries(node.choices)
    .map(([token, c]) => ({ token, label: copy.render(String(c?.label ?? token), seqCtx(S)) }))
}

/**
 * Feed the player's message to a running scene. Returns emissions, or null when
 * the message is not for it - a choice it does not recognise - so the caller
 * can say so rather than swallowing it.
 */
export function answerSequence (copy, S, raw) {
  if (!S.seq) return null
  const node = seqNodes(copy, S)[S.seq.at] || {}
  // What the node wants NOW, rather than what it wanted when the game was
  // saved. A writer who turns a choice into an ask has sessions sitting on the
  // old one, and `awaiting` alone would leave them answering a question that
  // is no longer on the page - refused every time, with only `skip` out.
  const awaiting = node.choices ? 'choice' : (node.ask ? 'ask' : S.seq.awaiting)

  if (awaiting === 'ask') {
    const said = capture(raw, node.max)
    // Nothing usable - an empty message, or one made of nothing but the
    // delimiters that get stripped. The question stands rather than being
    // answered with a blank, which would then be interpolated into every
    // later line that names it.
    if (!said) return null
    S.vars[String(node.ask)] = said
    applyEffects(S, node)
    S.seq.at += 1
    S.seq.awaiting = null
    return runSequence(copy, S)
  }

  if (awaiting !== 'choice') return null
  const choice = (node.choices || {})[String(raw ?? '').trim().toLowerCase()]
  if (!choice) return null
  applyEffects(S, choice)
  S.seq.at += 1
  S.seq.awaiting = null
  const reply = nodeEmit(copy, S,
    { speaker: choice.speaker, art: choice.art, delay: choice.delay,
      voice: choice.voice, title: choice.title }, choice.reply)
  return [...reply, ...runSequence(copy, S)]
}

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

/** Which day of the current week this is, 1-based. */
export const weekDay = (S) => (S.week?.length ?? 0) + 1

/**
 * The beat due right now, or null. A setpiece if this day of probation has one
 * and the player has not seen it; otherwise, on a repeat attempt, an `again`
 * line - a second week would be silent without them.
 */
export function beatDue (copy, S) {
  if (!S.probation) return null
  const schedule = copy.section('beats.schedule') || {}
  const id = schedule[String(weekDay(S))]
  if (id && !(S.beatsSeen || []).includes(id)) return { id, kind: 'setpiece' }
  if ((S.attempts || 1) > 1 && copy.list('beats.again').length) return { id: null, kind: 'again' }
  return null
}

/** Fire the due beat, if any. One with choices leaves itself pending. */
export function fireBeat (copy, S, ctx = {}) {
  const due = beatDue(copy, S)
  if (!due) return []
  if (due.kind === 'again') return [beatLine(copy, 'again', null, copy.t('beats.again'))]
  const spec = copy.section(`beats.${due.id}`)
  S.beatsSeen = [...(S.beatsSeen || []), due.id]
  applyEffects(S, spec)
  const key = typeof spec === 'string' ? `beats.${due.id}` : `beats.${due.id}.text`
  const out = [beatLine(copy, due.id, spec, copy.t(key, ctx))]
  if (spec && typeof spec === 'object' && spec.choices) S.beat = due.id
  return out
}

/** The choices a pending beat is waiting on, as {token, label} - or none. */
export function beatChoices (copy, S) {
  if (!S.beat) return []
  const spec = copy.section(`beats.${S.beat}.choices`)
  return Object.entries(spec || {}).map(([token, c]) => ({ token, label: String(c?.label ?? token) }))
}

/**
 * Answer a pending beat. Returns emissions, or null if `cmd` is not one of its
 * choices - in which case the caller carries on as though no beat were pending.
 */
export function answerBeat (copy, S, cmd, ctx = {}) {
  if (!S.beat) return null
  const token = String(cmd ?? '').trim().toLowerCase()
  const spec = copy.section(`beats.${S.beat}.choices`)
  const choice = spec && spec[token]
  if (!choice) return null
  const id = S.beat
  S.beat = null
  applyEffects(S, choice)
  return [beatLine(copy, id, choice, copy.t(`beats.${id}.choices.${token}.reply`,
    { ...ctx, coherence: S.coherence.toFixed(3) }))]
}
