# Office 4B, 6 Mackenzie Walk

## Quick installation

Fuller steps are further down. To run the game core and the client locally with
QDrive taken care of on the Moth API, which needs no Python at all:

```
npm ci
cp .env.example .env       # paste your Moth key into MW_MOTH_KEY
npm run moth               # http://localhost:5090
```

`.env.example` already selects the Moth API, so `npm start` does the same thing
once the key is in; `npm run moth` picks that backend whatever the file says.
Every engine call spends a credit, and a held step makes two of them.

To run with no key, no network and no Python, against invented physics:

```
npm ci
npm run fake
```

`npm run doctor` says what either path is still missing. The local backend,
which runs the real QDrive on your own machine, needs Python and two private
repositories; see [Setup](#setup) below.

## Overview

A turn-based trading game played against small quantum systems. You carry one
qubit; each world is a quantum circuit you may enter. Watch it, stake the day's
budget on one of its holdings, and hold: your qubit couples to that holding
every step you stay in, moves the price, and comes back changed.

The rules are a pure state machine that knows nothing about how it is shown.
This repository ships two renderers: the plainest possible HTML page, and a
Telegram bot. Anything that can send a token and show a list of messages can be
a third.

```
mackenziewalk_04/
  core/      the rules, the copy engine, the narrative - no I/O anywhere
    game.mjs        createGame(): sessions, turns, days, weeks, positions
    story.mjs       scripted scenes and the beats of the probation week
    copy.mjs        every word comes from copy.yaml, rendered here
    pricing.mjs     Bloch readings to quotes, the prospectus, the sheet
    pacing.mjs      how long each message waits, as the writer set it
    fake-model.mjs  invented physics, so everything runs without Python
    copy.yaml       every word the player reads
  model/           the physics: QDrive, spoken as JSON over stdio
    engine.py        ops: worlds, step, scout
    specs/           46 world specifications and their cached character
  host/            what every renderer needs, and nothing about any one of them
    setup.mjs        assembles rules, copy, worlds, physics, game, store
    specs.mjs        reads model/specs in JavaScript, for every backend
    model-local.mjs  the physics via model/engine.py
    model-http.mjs   the physics via the Moth API's qdrive-api-v1 engine
    render.mjs       a traces emission drawn as a PNG, and the art lookup
    store.mjs        one JSON file per session
    mirror.mjs       a browser turn said again in the chat, when both are on
    art/ fonts/      pictures the scenes name; the chart's typefaces
  client-http/     a web page. server.mjs, index.html, app.js
  client-telegram/ a Telegram bot. bot.mjs, sticker.mjs
  test/            selftest, copy-check, dryrun, doctor
```

Two clients, one game. Each owns its entry point and nothing else knows it
exists: `host/setup.mjs` assembles the same pieces for both, and every
difference between them is in how an emission becomes something a person sees.

## Setup

```
npm ci                          # node 20; .nvmrc names it
npm run doctor                  # what, if anything, is still missing
npm run fake                    # http://localhost:5090, no other setup at all
```

`npm run fake` plays the whole game against invented physics, so a fresh clone
is one command from running. The other two backends need something this
repository cannot carry; `npm run doctor` says which, where it looked, and what
to run next.

Three physics backends, chosen with `MW_MODEL`:

| | | |
|---|---|---|
| `fake` | invented, deterministic trajectories | needs nothing. `npm run fake` |
| `local` | `model/engine.py` in a Python of your own | the default |
| `http` | the Moth API's `qdrive-api-v1` engine | needs a key; a credit a step |

```
cp .env.example .env            # pick a backend and fill in what it needs
npm start
```

For `local`, the Python needs `model/requirements.txt` plus Moth's QDrive, and
`MW_QDRIVE_API_SRC` pointing at a qdrive-api checkout's `src/` (a checkout at
`../coupling-playground/qdrive-api` is found on its own):

```
python3 -m venv model/.venv                          # 3.12 or newer
model/.venv/bin/pip install -r model/requirements.txt
model/.venv/bin/pip install -e /path/to/QDrive
```

`model/.venv` is found automatically; `MW_PYTHON` overrides, and pointing it at
the interpreter you mean is usually necessary — whatever `python3` is on PATH is
rarely new enough. For `http`, put the key in `MW_MOTH_KEY` or name a file
holding it in `MW_MOTH_KEY_FILE`. The host checks the engine is there at boot
without spending anything.

## Dependencies

Everything the game needs at runtime is committed except the two private Python
packages, which no clone of this repository can fetch:

| | | |
|---|---|---|
| node packages | `package.json` + `package-lock.json` | `npm ci` reproduces them exactly, native chart binaries for every platform included |
| node itself | `.nvmrc` | 20; `package.json` accepts 18 and up |
| the words | `core/copy.yaml` | committed |
| the worlds | `model/specs/*.json` | committed, with `_stats_cache.json` — the volatility the prospectus quotes, which costs minutes to recompute |
| art and fonts | `host/art/`, `host/fonts/` | committed, so a chart looks the same everywhere |
| python packages | `model/requirements.txt` | current releases; `model/requirements.lock.txt` pins an environment known to work, and names the Python version |
| **QDrive** | github.com/moth-quantum/QDrive | **private.** Clone it, then `pip install -e /path/to/QDrive` |
| **qdrive-api** | github.com/moth-quantum/qdrive-api | **private.** Clone it and point `MW_QDRIVE_API_SRC` at its `src/`. Never pip-installed — its modules are flat and one is called `engine.py` |

Not committed, and deliberately: `.env` (`.env.example` shows its shape),
`host/state/` (saved games and rendered charts, created on demand), and
`node_modules/`, `.venv/`, `__pycache__/`.

Never put a credential in a pip URL. Pip records the URL verbatim in the
installed metadata, so a token in one comes back out of every later
`pip freeze` — which is exactly how such a thing reaches a committed file.

## Time

Nothing moves until you do. One step of a world - t3 to t4, whether you are
watching or holding - is one step of the game clock, and:

| | |
|---|---|
| a world | as long as you stay in it. It has no length of its own |
| a day | 27 steps, however you spend them |
| a week | seven days |
| the bell | the day's 27th step closes any open position where it stands, and the world with it |
| the night | restores a spent qubit by nine steps' worth |
| the chart | 15 readouts at a square each; older ones age off the left |

A world runs until you leave it, close out of it, or the bell closes you, so
how far one can be taken is however much of the day was left when you walked
in. Entering and leaving cost nothing; the hours spent watching it are spent
either way. `wait` is the one step that moves no world at all - the hour
goes, the qubit recovers, and every world stands where it stood, which is how
a spent terminal is cleaned up without a world's readouts going with it.

Your qubit recovers a ninth per step while you watch or wait, not while you
hold, and nothing buys a faster clock than that. What the workshop sells is
the hour itself: €$10 out of the day's budget, one step's worth of recovery,
handed over on the spot. It will not sell more than the terminal has room for,
and charges only for what lands.

## The day

Money is an allowance, not a bankroll. Each day opens with a fresh budget and
closes with the books:

| | |
|---|---|
| opening budget | €$1,000, never below €$500, never carried over |
| a day that clears 10% of its budget | tomorrow's budget rises 10% |
| any other day, an idle one included | tomorrow's budget falls 5% |
| out of money | the rest of the day is forfeit and the bell rings |
| the seventh day, on probation | the week's profit must clear a twentieth of every budget the week was handed - 350 on an unchanged week, and it moves with the budget. A failed one starts the week again |
| the seventh day, afterwards | a positive week pays €$100 into a personal pot that cannot be staked |

A position is opened with no end date on it: it runs a step at a time, for as
long as the player keeps holding, and closes when they say so. Left open, it
closes itself at the world's last readout, or where it stands when the bell
rings.

## Playing

Every choice arrives as a button and as a token you could have typed instead,
so free text keeps working.

| | |
|---|---|
| `1` `2` `3` | enter one of the three worlds on offer · `m` the workshop |
| `i` `o` `l` | invest, observe one more step, or leave - at any point, having watched or not |
| a number, twice | the stake, then the holding |
| `h` `c` | hold one more step, or close where it stands |
| `b` `l` | buy hours of recovery, or leave the workshop |
| `wait` | let one step pass with nothing in it, anywhere but mid-position |
| `help` `state` | the rules read out again, and your standing; either works mid-position |
| `skip` | end the opening scenes |

A setpiece that opens a day and asks something holds the day's worlds behind
it: its choices would otherwise arrive in the same row as the three worlds,
with nothing on screen to say which question a keystroke was answering.

## Clients

The same game, two ways in, and - when it matters - the same game.

```
npm start                  # both: the browser on http://localhost:5090, and the bot
npm run web                # the browser client alone
npm run telegram           # the bot alone
```

`npm start` runs `server.mjs`, which is what gets deployed: one host, one store,
one queue, two renderers. That is not tidiness. A saved game is a file and the
store keeps a hot copy in memory, so two processes over one directory would each
be certain they had the newer one - which is exactly what happens the moment a
player is in both. Running them apart is still right for development, when
nobody is.

What the clients own separately is how a turn looks: the browser gets a page it
can replay, Telegram gets messages it cannot. What they share is what a turn is.

The bot needs a token from @BotFather in `TELEGRAM_BOT_TOKEN`; with none set,
`npm start` serves the website alone and says so. Telegram allows exactly one
long poll per token and a second one evicts the first, so a laptop and a server
cannot share a bot: make two, and set `MW_LOCAL=1` to use
`TELEGRAM_BOT_TOKEN_LOCAL` instead. `MW_ALLOW` is an optional comma-separated
list of Telegram user ids; set it and only those may play. The bot answers
private chats only - a game is one person's, and the id it is saved under is
theirs.

## Signing in

A game belongs to a subject, which the server decides and the client never
names: `web<random>` for a guest, `tg<telegram user id>` once someone has signed
in. It travels in a cookie the server signs with `MW_SECRET`, so a request says
only what the player did.

Anyone can play without signing in. Signing in - the Telegram Login Widget,
whose payload is checked against the bot token in `host/auth.mjs` - is what
joins the browser and the chat into one game:

- **Nothing under their name yet.** The game they were playing as a guest
  becomes theirs, as it stands.
- **A game in the chat and nothing much here.** They get the one from the chat.
- **Two real games.** They are shown both and asked. The one they let go is kept
  on disk as `tg<id>.<stamp>.bak` rather than deleted.

It needs `MW_BOT_USERNAME`, and it needs the deployed domain registered with
`/setdomain` in BotFather. Without that the widget renders and then signs nobody
in, with no error anywhere.

Once they are joined, a turn taken in the browser is also spoken into the chat -
`host/mirror.mjs`, wired up in `server.mjs`, and only there, so `npm run web`
and `npm run telegram` apart behave as they always did. It goes one way only:
the browser replays the saved transcript whenever the page is opened, so a day
played in Telegram is already there on the next reload. The chat is not sent a
turn it cannot receive either - somebody who signed in on the website and never
opened the chat costs one line in the log, because a bot may not speak first.

In the chat, every choice arrives as an inline button and as a token you could
have typed, so the whole game is playable either way. Slash commands are
aliases for the same tokens:

| | |
|---|---|
| `/start` | begin, or pick up an existing game where it stands |
| `/restart` | throw that game away and begin again |
| `/status` `/help` `/market` `/skip` | the same as typing `state`, `help`, `m`, `skip` |

Two things the chat does that the page does not. Scene art goes as a **sticker**
rather than a photo, because the art is cut out of its background and Telegram
fits a photo to the message column, which stretches a portrait or paints a
blurred copy behind it. And a tap on an **old keyboard is refused**: Telegram
leaves every keyboard it has ever sent live, while the game reuses its tokens,
so a stale `5` would otherwise stake 5G because it used to mean t5. Typing `5`
still works, because typing it is deliberate.

A chat session is keyed `tg<chat id>`, so it cannot collide with a browser one
in the same store.

## Writing

Every word a player reads lives in `core/copy.yaml`: messages, button labels,
world names, tickers, the complexity vocabulary, the scenes and the beats. The
host re-reads the file on save. [WRITING.md](WRITING.md) has the schema for
scenes and beats; each message in the file is commented with the values it may
use, and

```
npm run copy-check
```

plays through the game with a recording copy object and checks both directions:
that every key the code asks for exists, and that every `{placeholder}` a
message uses is one the engine actually supplies. A missing key or bad filter
degrades one message; it never stops a turn.

## How the pieces fit

`core/game.mjs` exports `createGame({ copy, model, rules })`. The game holds
no timers, reads no files and draws nothing:

```js
const game = createGame({ copy, model })
const S = game.newSession(seed)
let r = await game.start(S)            // { emissions, choices, summary }
r = await game.handle(S, 'i')          // one token in, the same shape out
```

Emissions are what a renderer shows, in order:

| kind | fields | |
|---|---|---|
| `text` | `text`, `speaker?`, `title?`, `voice?` | a small markdown subset: `**bold**`, `_italic_`, `` `code` `` |
| `art` | `art`, `text?`, `speaker?`, `title?`, `voice?` | a named picture; `host/art/<name>.png` here |
| `traces` | `title`, `caption?`, `n`, `holdings`, `priced`, `clean`, `upto`, `from`, `totalReadouts`, `target`, `interventionAt`, `foot`, `f` | a chart; `host/render.mjs` draws it, or a renderer draws its own from the numbers. `priced` is the quote series, `f` the value factor behind it. `from` is the readout the paper's left edge stands on: a world can outlive the 15 readouts a sheet holds, so the older ones age off the left while the series itself is never cut - the listing price and the price ladder are read off the whole of it. The game sends charts without a caption - what one says is drawn on it |

`title` is the heading over a line: a speaker's name is one, and so is
`Day 3` or `Report: Liked Rounds`, which the game reads from a `<key>_title`
beside the body in copy.yaml. `voice: 'player'` marks a line spoken by or
about the player rather than at them - a writer sets it on a node, because a
scripted line narrating what the player just did and a line of somebody else's
narration are both text with no speaker on them, and nothing downstream can
tell them apart. Both exist for renderers that draw the difference: the
browser heads a message with the one and picks a side of the page with the
other, while Telegram prints a heading as a bold line and ignores the voice.

`choices` is the list of `{ token, label, kind }` the player may send next,
where `kind` is `game`, `scene` or `beat` - a beat's choices arrive alongside
the game's own and a renderer should set them apart, since a beat token
shadows a game command of the same name. `summary` is the standing in
numbers.

Every emission also carries `delay`, the milliseconds a client waits before
showing it, and a scene's carry `pace: true` besides. The numbers are the
writer's, set in seconds under `pacing:` in copy.yaml and resolved by
`core/pacing.mjs` at the one seam every emission leaves through - so a game
played in the chat and read back in the browser runs to the same rhythm. A
minimum sits under every message, including the game's own; a scene's nodes
wait longer, and any one of them may say how long. The gap is the one BEFORE a
message and the first of a turn never waits. `help` reads a scene back without
its dramatic timing, but still a message at a time. `MW_PACE` scales the lot
for the Telegram client; `MW_PACE=0` turns it off.

The model is anything with two methods:

```
worlds()                                -> [info]
step({ world, circuit, enter, couple }) -> { circuit, r, apparatus }
```

`r` is one Bloch vector per holding, `[<X>, <Y>, <Z>]`, and `apparatus` is the
player's own qubit read the same way, or null while it is out of the circuit.
The price reads all three axes - see `core/pricing.mjs` - because QDrive's
single-qubit tomography measures all three anyway, so two of them were being
thrown away.

A world is stepped one request at a time and `circuit` is whatever the backend
needs to carry a run between them: QASM3 text for the local engine, an asset
id for the HTTP one, a small object for the fake. The game stores it in the
session and hands it back. `enter` widens the circuit so the player's qubit
joins it, `couple` drives its correlation with a holding for that step. While a
position is held the uncoupled world is stepped alongside, so the chart can
show where the price was going before the player touched it
(`MW_COUNTERFACTUAL=0` turns that off and halves the model calls).

`model/engine.py` answers `worlds`, `step` and `scout`. `model/selftest.py`
checks that a world stepped in ten processes is the world stepped in one, and
that widening a circuit in text - which the HTTP backend has to do, having no
qiskit - builds the same circuit qiskit does.

Sessions are one JSON file each under `host/state/`, named by subject, with the
transcript the page replays on reload. The transcript holds one thing the turn
itself does not: a `{ kind: 'said', text }` entry for what the player sent,
recorded as the LABEL of whatever it answered - `Call the lift` rather than
`a`, which on its own means nothing a week later. It is written in
`createSessions` rather than emitted by the game, because a client showing a
live turn has already put the player's move on screen its own way; without it a
transcript read back from disk is one side of a conversation, with the
questions on it and none of the answers. Every chart is rendered once to
`host/state/png/` and both clients are handed the same URL for it - Telegram
uploads the bytes and puts the URL in the transcript, so a day played in the
chat can be read back in the browser with its pictures. Charts older than
`MW_SWEEP_DAYS` are swept; nothing else here grows.

## Tunables

All optional, all in `.env.example`: `MW_STEPS` (10, the horizon volatility is
measured over), `MW_CHART_READOUTS` (15), `MW_DAY_STEPS` (27),
`MW_WEEK_DAYS` (7), `MW_REGEN_STEPS` (9),
`MW_NIGHT_STEPS` (9), `MW_START_BUDGET`, `MW_BUDGET_FLOOR`, `MW_QUOTA`,
`MW_WEEK_BONUS`, `MW_UPGRADE_COST` (€$10 an hour), `MW_PROBATION`, `MW_PROBATION_SHARE`,
`MW_COUNTERFACTUAL`, `PORT`, `MW_BIND`, `MW_STATE_DIR`, `MW_SECRET`,
`MW_BOT_USERNAME`, `MW_PUBLIC_URL`, `MW_TRUST_PROXY`, `MW_SWEEP_DAYS`.

`MW_STEPS` no longer sets how long a world runs - the day does that - and is
only the horizon its advertised volatility is measured over. Changing it
invalidates `model/specs/_stats_cache.json`, which holds that figure; `npm run
warm` recomputes it with the local Python.

## Checking

```
npm run doctor           # what this machine is missing for the backend you picked
npm test                 # the rules, identity, both clients - no Python, no network
npm run copy-check       # copy.yaml, both directions
npm run dryrun           # a round in the terminal; --model local|http, --png <dir>
npm run model-test       # the physics, against the real engine
```

`npm test` runs four files: `selftest.mjs` (the rules and the chart),
`auth.mjs` (the two signature schemes identity rests on), `web.mjs` (a real
server on a socket: that a request cannot name another player's game, every way
a login can land, and one game played through both clients at once) and
`telegram.mjs` (the chat client, with grammY driven in memory). It and
`npm run copy-check` need nothing but `npm ci`, so they run on a fresh clone and
in CI. `npm run model-test` and `npm run warm` need the local
Python; `npm run dryrun --model http` spends credits.

## Deploying

`deploy/` has the whole of it: a systemd unit, a Caddyfile, two backup units and
a runbook. One Node process behind Caddy on a Hetzner box, deployed with
`git pull && npm ci && systemctl restart`. See `deploy/README.md`.

## Third-party code

See [NOTICE.md](NOTICE.md).
