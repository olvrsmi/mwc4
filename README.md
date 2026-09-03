# Office 4B, 6 Mackenzie Walk

A turn-based trading game played against small quantum systems. You carry one
qubit; each world is a quantum circuit you may enter. Watch it, stake the day's
budget on one of its holdings, and hold: your qubit couples to that holding
every step you stay in, moves the price, and comes back changed.

The rules are a pure state machine that knows nothing about how it is shown.
This repository ships one renderer, the plainest possible HTML page. Anything
that can send a token and show a list of messages can be another.

```
mackenziewalk_04/
  core/      the rules, the copy engine, the narrative - no I/O anywhere
    game.mjs        createGame(): sessions, turns, days, weeks, positions
    story.mjs       scripted scenes and the beats of the probation week
    copy.mjs        every word comes from copy.yaml, rendered here
    pricing.mjs     readings to quotes, the prospectus, the sheet
    fake-model.mjs  invented physics, so everything runs without Python
    copy.yaml       every word the player reads
  model/     the physics: QDrive, spoken as JSON over stdio
    engine.py       ops: worlds, step, scout
    specs/          46 world specifications and their cached character
  host/      the Node host for the HTML client
    server.mjs      HTTP + JSON, sessions, PNG rendering, static files
    specs.mjs       reads model/specs in JavaScript, for every backend
    model-local.mjs the physics via model/engine.py
    model-http.mjs  the physics via the Moth API's qdrive-api-v1 engine
    render.mjs      a traces emission drawn as a PNG
    store.mjs       one JSON file per session
    art/ fonts/     pictures the scenes name; the chart's typefaces
  client/    index.html + app.js: default styling, a border per message
  test/      selftest, copy-check, dryrun
```

## Setup

```
npm install
cp .env.example .env            # pick a model backend, see below
npm start                       # http://localhost:5090
```

Three physics backends, chosen with `MW_MODEL`:

| | | |
|---|---|---|
| `fake` | invented, deterministic trajectories | no Python, no network. `npm run fake` |
| `local` | `model/engine.py` in a Python of your own | the default |
| `http` | the Moth API's `qdrive-api-v1` engine | needs a key; one credit a step |

For `local`, the Python needs `model/requirements.txt` plus Moth's QDrive, and
`MW_QDRIVE_API_SRC` pointing at a qdrive-api checkout's `src/` (a checkout at
`../coupling-playground/qdrive-api` is found on its own):

```
python3 -m venv model/.venv                          # 3.12 or newer
model/.venv/bin/pip install -r model/requirements.txt
model/.venv/bin/pip install -e /path/to/QDrive
```

`model/.venv` is found automatically; `MW_PYTHON` overrides. For `http`, put
the key in `MW_MOTH_KEY` or name a file holding it in `MW_MOTH_KEY_FILE`. The
host checks the engine is there at boot without spending anything.

## Time

Nothing moves until you do. One step of a world - t3 to t4, whether you are
watching or holding - is one step of the game clock, and:

| | |
|---|---|
| a world | ten readouts, t0 to t9, so nine steps |
| a day | 27 steps: three worlds watched to the end, or however you spend them |
| a week | seven days |
| the bell | the day's 27th step closes any open position where it stands |
| the night | restores a spent qubit by nine steps' worth |

Entering a world and leaving it at t0 cost nothing. Your qubit recovers a
ninth per step while you watch, not while you hold; the workshop sells a
quarter more per step, once, out of the day's budget.

## The day

Money is an allowance, not a bankroll. Each day opens with a fresh budget and
closes with the books:

| | |
|---|---|
| opening budget | 1,000G, never below 500G, never carried over |
| a day that clears 10% of its budget | tomorrow's budget rises 10% |
| any other day, an idle one included | tomorrow's budget falls 5% |
| out of money | the rest of the day is forfeit and the bell rings |
| the seventh day, on probation | a positive week passes; a failed one starts the week again |
| the seventh day, afterwards | a positive week pays 100G into a personal pot that cannot be staked |

A position may be closed early at any step. One chosen to end after the bell
is queried first, and offered a way back.

## Playing

Every choice arrives as a button and as a token you could have typed instead,
so free text keeps working.

| | |
|---|---|
| `1` `2` `3` | enter one of the three worlds on offer · `m` the workshop |
| `i` `o` `l` | invest, observe one more step, or leave (only at t0) |
| a number, three times | the stake, the holding, the exit point |
| `h` `c` | hold one more step, or close where it stands |
| `b` `l` | buy upgrades, or leave the workshop |
| `help` `state` | the rules read out again, and your standing; either works mid-position |
| `skip` | end the opening scenes |

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
| `text` | `text`, `speaker?` | a small markdown subset: `**bold**`, `_italic_`, `` `code` `` |
| `art` | `art`, `text?`, `speaker?` | a named picture; `host/art/<name>.png` here |
| `traces` | `title`, `caption`, `n`, `holdings`, `priced`, `clean`, `upto`, `totalReadouts`, `target`, `interventionAt`, `foot`, `z` | a chart; `host/render.mjs` draws it, or a renderer draws its own from the numbers |

`choices` is the list of `{ token, label }` the player may send next. `summary`
is the standing in numbers. Scene emissions also carry `pace: true`, for a
host that wants to space a burst out.

The model is anything with two methods:

```
worlds()                                -> [info]
step({ world, circuit, enter, couple }) -> { circuit, z, apparatus }
```

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

Sessions are one JSON file each under `host/state/`, with the transcript the
page replays on reload. Every chart is rendered once to `host/state/png/` and
the page is handed a URL.

## Tunables

All optional, all in `.env.example`: `MW_STEPS` (10 readouts a world),
`MW_DAY_STEPS` (27), `MW_WEEK_DAYS` (7), `MW_REGEN_STEPS` (9),
`MW_NIGHT_STEPS` (9), `MW_START_BUDGET`, `MW_BUDGET_FLOOR`, `MW_QUOTA`,
`MW_WEEK_BONUS`, `MW_UPGRADE_COST`, `MW_PROBATION`, `MW_PROBATION_PROFIT`,
`MW_COUNTERFACTUAL`, `PORT`, `MW_STATE_DIR`.

Changing `MW_STEPS` invalidates `model/specs/_stats_cache.json`, which holds
the volatility the prospectus quotes; `npm run warm` recomputes it with the
local Python.

## Checking

```
npm test                 # the rules, the copy engine, the backends, the chart - no Python
npm run copy-check       # copy.yaml, both directions
npm run dryrun           # a round in the terminal; --model local|http, --png <dir>
npm run model-test       # the physics, against the real engine
```

## Third-party code

See [NOTICE.md](NOTICE.md).
