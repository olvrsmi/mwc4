# Writing scenes and beats

Everything a player reads lives in `core/copy.yaml`. Nothing else needs
touching to change a word, add a scene or move a beat, and the host re-reads
the file on save, so an edit shows in the next message without a restart.

Values in `{braces}` arrive already formatted: `{budget}` is `1,000G`,
`{coherence}` is `0.999`. When prose needs to bend there are escape hatches -
`{n} opportunit{n|s:y:ies}`, `{#if recovering} …{/if}`, `{#if x}a{:else}b{/if}`,
`{balance_raw|money}` - but ordinary lines need none of them. Anywhere a list
is given, one line is picked at random. `npm run copy-check` reads the whole
file back against what the game supplies.

## Scenes

A **sequence** is a scripted scene: a list of nodes played in order, stopping
wherever it wants something from the player. Everything up to that stop is
sent in one burst. They live under `sequences:`; which of them make up a first
sitting, and in what order, is the `opening:` list:

```yaml
opening:
  - intro
  - office
```

Each plays once. When one ends the next begins, and when the last is done the
game starts - the standing, three worlds, and any beat due. A scene named in
`opening` that is not written yet is skipped, so one can be declared before it
is written. `skip` skips the whole opening.

### A node

```yaml
sequences:
  intro:
    - art: tower                      # a picture alone

    - art: himbo                      # a picture and a line
      speaker: Daniel
      text: |
        There you are, you made it past security.

    - text: |                         # stops here and waits
        The lift arrives.
      choices:
        a:
          label: Call the lift
          speaker: Daniel
          reply: |
            Whoa ok we got an ambitious one.
        b:
          label: Do nothing
          reply: |
            _Presses lift button_

    - speaker: Daniel                 # both branches arrive here
      text: |
        You golf?
```

| field | |
|---|---|
| `art` | a name in `host/art/` - `png`, `jpg`, `webp` or `gif`. A name with no file plays as its line alone, so write before it is drawn |
| `speaker` | who is talking; a renderer shows it bold above the line |
| `text` | what they say |
| `choices` | keyed `a`, `b`, `c`… - **any number**. Each has a `label` and a `reply`, and may carry its own `art` and `speaker` |
| `ask` | capture what the player types next into a named variable |
| `delay` | seconds to wait before this line arrives - see [Timing](#timing) |

Choices **colour the moment and rejoin**: the reply plays, then the scene
carries on from the next node. There is no branching to track. The key is the
token the player sends and the label is what the button says; choices are
keyed rather than listed so copy-check can see inside them.

Keep a key short. It is what a chat client puts inside a button, and Telegram
caps that at 64 bytes and refuses the message rather than truncating, so
`copy-check` fails a longer one for you. `a`, `b`, `c` are the convention.

### Asking the player something

```yaml
    - speaker: Himbo
      text: What do we call you?
      ask: name
    - speaker: Himbo
      text: |
        Alright, {name}. This way.
```

Whatever they type is stored and readable as `{name}` in every later line of
every scene. It is trimmed, cut to 60 characters (by character, so an answer
of emoji cannot come back broken), and has `` ` ``, `*` and `_` removed. Those
three are the delimiters of the markdown below, and a player who typed one
would otherwise swallow the emphasis in whatever line you put their answer in.

### Effects

On a choice or an `ask`: `coherence: 0.04` as a delta on the player's qubit,
clamped to 0…1, and `unlock: some_id`, which notes an id for later and does
nothing else yet. Scenes deliberately cannot grant money.

### Timing

A turn can produce several messages. They arrive one at a time, each waiting
a moment first, so a scene written as someone talking reads as someone
talking. The gaps are yours, in **seconds**, at the top of `copy.yaml`:

```yaml
pacing:
  minimum: 0.6      # under every message, the game's own included
  scene: 1.4        # a line in a sequence or a beat
  max: 20           # a ceiling, so a typo cannot park the game
  scenes:
    tutorial: 3     # this one scene, instead of `scene`
```

`minimum` is the one that stops a burst landing all at once. `scene` is
dramatic timing on top of it, which is why it is longer.

Any single line can say its own, and this is where most of the feel is:

```yaml
    - text: |
        ...
      delay: 3
    - text: |
        _ding_
      delay: 0.4
    - text: |
        Catch you on a drinkfood break maybe.
```

A choice's `reply` takes a `delay` the same way, and so does a beat. The
number is the gap **before** that message; the first message of a turn never
waits, because it is the answer to what the player just did.

Nothing may be quicker than `minimum` or slower than `max` — a `delay: 1400`
meant as milliseconds is caught by `copy-check` rather than stopping the game
for twenty-three minutes. To see the rhythm without playing it:

```
npm run dryrun
```

which prints a `[wait ]` line for every gap.

### Placeholders

`{budget}`, `{coherence}`, and anything an earlier `ask` captured.

### What a scene interrupts

Everything. A running scene has the floor: a command it does not recognise gets
*"Someone is still talking"* rather than reaching the game. `skip` ends it.

### The help scene

`help` reads one scene out again at any moment - mid-position, at the bell -
without entering it, so that scene must not stop to ask anything. Name it with
`help_scene:` at the top level; `voice` is assumed when absent.

### The verdicts

A probation week ends on a scene: `probation_passed`, `probation_failed`, and
`probation_failed_again` for the second failure onward (leave it empty and the
full scene plays again). They read the week's numbers - `{total}`, `{attempt}`,
`{failures}`, `{again}`, `{budget}`, `{coherence}` - and may have choices like
any other scene. The new week is offered when the scene is done.

## Beats

A **setpiece** is keyed to a day of the probation week and fires once ever when
that day begins - after the bell's accounting, or with the first offer on day
one.

```yaml
beats:
  schedule:
    2: change1          # day 2 fires the beat named `change1`
    3: the_himbo

  change1: |
    _[your mouse feels different today]_

  the_himbo:
    text: |
      **Daniel has a theory.**
    choices:
      a:
        label: Humour him
        reply: |
          "See, you get it."
      b:
        label: Point at the quota
        reply: |
          "Oh, the quota."
        coherence: 0.04
```

A beat that is just text can be a bare string. Choices work as in a scene and
carry the same two effects; an effect on the beat itself applies however the
player answers. A beat and its choices take a `delay` as a scene's node does -
see [Timing](#timing) - though a bare string cannot, since there is nowhere to
hang it; give it `text:` and it can.

### What a beat interrupts

Nothing. A beat may arrive mid-position and its choice can be answered
whenever - its buttons sit alongside the game's. A command that is not one of
its choices reaches the game untouched, so a pending beat can never swallow a
`state` or an `i`. This is the opposite of a scene.

### Repeat attempts

A setpiece fires once ever, not once per attempt, so a player who fails
probation and starts again would hear nothing. `again` is the answer: short
lines, picked at random, for a floor that carries on without you:

```yaml
  again:
    - _Nobody looks up when you sit down._
    - _A cleaner works around you without asking you to move._
```

### Placeholders

`{day}` the day of the week, 1-based · `{budget}` today's budget · `{attempt}`
which attempt this is. A choice's `reply` also gets `{coherence}`, after its
own effect has applied.

## Checking

```
npm run copy-check      # every key a writer typed, validated both ways
npm test                # the scene and beat mechanics
npm run dryrun          # play a round and watch the opening arrive
```
