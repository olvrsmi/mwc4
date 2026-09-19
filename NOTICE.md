# Third-party code and data

## Roboto Condensed and Roboto Mono — `host/fonts/`

Copyright Google. Licensed under the SIL Open Font License 1.1 — see
`host/fonts/OFL-RobotoCondensed.txt` and `host/fonts/OFL-RobotoMono.txt`.

Upstream: https://github.com/google/fonts/tree/main/ofl

The variable-weight `.ttf` files, unmodified. Vendored rather than installed on
the host, because a box without them would silently fall back to whatever it did
have and draw a different chart than the one designed here.

`RobotoMono-ExtraLight.ttf`, `RobotoMono-Regular.ttf` and `RobotoMono-Bold.ttf`
are static instances cut from `RobotoMono[wght].ttf` at wght 200, 400 and 700
with `fontTools.varLib.instancer` — a modification, made because canvas cannot
interpolate a variable font for itself and would otherwise draw every weight as
Regular. The OFL permits it; the reserved font name is untouched.

## QDrive and qdrive-api

`model/engine.py` drives Moth's QDrive through the qdrive-api engine. Both are
private and neither is vendored here; see `model/requirements.txt` for how they
are installed alongside.

## Everything else

`core/`, `host/`, `client-http/`, `client-telegram/`, `test/`, `model/engine.py`
and the documentation
are original to this repository. The npm dependencies (`yaml`,
`@napi-rs/canvas`, `grammy`) are MIT-licensed and pulled at install time rather than
vendored. No licence has been chosen for this repository yet.
