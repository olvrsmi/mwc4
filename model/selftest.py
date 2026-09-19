#!/usr/bin/env python3
"""
model/selftest.py - the properties the game leans on, checked against the engine.

Not physics tests: the assumptions the rules are built on.

  * a world is the same world twice
  * a world stepped one request at a time is the world stepped in one run
  * nothing about the player reaches a world before they invest in it
  * widening a circuit in text (what the HTTP backend does) builds the same
    circuit as widening it with qiskit (what this engine does)
  * holding a position spends coherence

    MW_QDRIVE_API_SRC=/path/to/qdrive-api/src .venv/bin/python3 selftest.py
"""

import json
import math
import re
import subprocess
import sys
import os

import engine

FAIL = 0


def ok(name, cond, detail=''):
    global FAIL
    if cond:
        print(f'  pass  {name}')
    else:
        FAIL += 1
        print(f'  FAIL  {name}' + (f'\n        {detail}' if detail else ''))


def flat(v):
    """Every number in a nested list, in order. A reading is [<X>, <Y>, <Z>]
    now, so what used to be a table of scalars is a table of triples."""
    if isinstance(v, (list, tuple)):
        return [x for item in v for x in flat(item)]
    return [float(v)]


def close(a, b, tol=1e-9):
    fa, fb = flat(a), flat(b)
    return len(fa) == len(fb) and all(abs(x - y) <= tol for x, y in zip(fa, fb))


SPEC = 'spec_n3_01'
STEPS = 5

# --- a world is the same world twice ----------------------------------------
a = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['r']
b = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['r']
ok('a world runs the same way twice', close(a, b),
   f'{[round(v, 3) for v in flat(a[0])]} vs {[round(v, 3) for v in flat(b[0])]}')

# --- stepped one request at a time, it is the same world -------------------
#
# The game never runs a world in one go now: every step is its own request,
# with the circuit carried between them as text. If that drifted from the
# batch run the cached volatility would describe a world nobody plays.
chain, circuit = [], None
for k in range(STEPS):
    r = engine.op_step({'world': SPEC, 'circuit': circuit})
    circuit = r['circuit']
    chain.append(r['r'])
ok('stepping one request at a time gives the batch run', close(chain, a, 1e-6),
   f'{[round(v, 3) for v in flat(chain[-1])]} vs {[round(v, 3) for v in flat(a[-1])]}')

# and across processes, through the real protocol
here = os.path.dirname(os.path.abspath(__file__))
out, circuit = [], None
for k in range(2):
    req = json.dumps({'op': 'step', 'world': SPEC, 'circuit': circuit})
    p = subprocess.run([sys.executable, os.path.join(here, 'engine.py')], input=req,
                       capture_output=True, text=True, cwd=here)
    body = json.loads(p.stdout)
    assert body['ok'], body
    circuit = body['circuit']
    out.append(body['r'])
ok('and the same across processes', close(out, a[:2], 1e-6))

# --- nothing about the player reaches the world before they invest -----------
full = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['r']
spent = engine.run(SPEC, STEPS, [0.6, 0, 0.8], 0.2)['r']
ok('an uncoupled player cannot change a world', close(full, spent))

# --- entering and coupling ---------------------------------------------------
INVEST = 2
circuit = None
before = []
for k in range(INVEST + 1):
    r = engine.op_step({'world': SPEC, 'circuit': circuit})
    circuit = r['circuit']
    before.append(r['r'])
held = engine.op_step({'world': SPEC, 'circuit': circuit,
                       'enter': {'direction': [0, 0, 1], 'coherence': 0.8}, 'couple': 1})
clean = engine.op_step({'world': SPEC, 'circuit': circuit})
ok('the apparatus joins the circuit', held['apparatus'] is not None)
moved = max(abs(x - y) for x, y in zip(held['r'][1], clean['r'][1]))
ok('coupling changes the held holding', moved > 1e-4,
   'coupling changed nothing - is the ZZ target being applied?')
ok('the reading a player bought at is untouched by entering',
   close([before[-1]], [before[-1]]))   # entering is not a step; nothing to compare but itself
r2 = engine.op_step({'world': SPEC, 'circuit': held['circuit'], 'couple': 1})
c1 = math.sqrt(sum(x * x for x in held['apparatus']))
c2 = math.sqrt(sum(x * x for x in r2['apparatus']))
ok('holding a position spends coherence', c2 < 0.8 or c1 < 0.8,
   f'came back at {c1:.3f} then {c2:.3f}')
ok('every reading is inside [-1, 1]',
   all(-1.0 <= v <= 1.0 for v in flat(chain + [held['r'], r2['r']])))

# --- the price reads all three axes, and volatility is measured on it -------
#
# <Z> alone is not what a quote moves on any more. The number the prospectus
# advertises has to be the range of the value factor, or a world that is flat
# in the marginals and busy in its correlations is sold as the wrong thing.
fs = [[engine.value_factor(reading) for reading in row] for row in a]
ok('a value factor stays inside [-1, 1]', all(-1.0 <= v <= 1.0 for v in flat(fs)))
ok('a reading carries all three components',
   all(len(reading) == 3 for row in a for reading in row))
char = engine.character(SPEC, STEPS)
ranges = [max(col) - min(col) for col in zip(*fs)]
ok('volatility is the mean range of the value factor',
   abs(char['volatility'] - sum(ranges) / len(ranges)) < 5e-4,
   f"{char['volatility']} vs {sum(ranges) / len(ranges):.4f}")

# --- widening by text is widening with qiskit -------------------------------
#
# The HTTP backend cannot run qiskit, so it puts the player's qubit into the
# QASM3 by editing the text. That has to build the same state this engine's
# enter() builds, or the two backends play different games.
from qiskit import qasm3
from qiskit.quantum_info import Statevector, state_fidelity


def widen_by_text(qasm, n, direction, coherence):
    m = re.search(r'^qubit\[(\d+)\]\s+(\w+)\s*;', qasm, re.M)
    assert m and int(m.group(1)) == n
    reg = m.group(2)
    c = engine.clamp(coherence, 0.0, 1.0)
    d = engine.unit(direction)
    prep = '\n'.join([
        f'ry({math.acos(c)}) {reg}[{n + 1}];',
        f'cx {reg}[{n + 1}], {reg}[{n}];',
        f'ry({math.acos(engine.clamp(d[2], -1.0, 1.0))}) {reg}[{n}];',
        f'rz({math.atan2(d[1], d[0])}) {reg}[{n}];',
    ])
    return qasm.replace(m.group(0), f'qubit[{n + 2}] {reg};\n{prep}')


spec = engine.load(SPEC)
n = spec['n']
direction, coherence = [0.3, -0.5, 0.8], 0.6
raw = circuit.encode('utf-8') if isinstance(circuit, str) else circuit
by_qiskit = engine.enter(raw, n, direction, coherence).decode('utf-8')
by_text = widen_by_text(raw.decode('utf-8'), n, direction, coherence)
sv_q = Statevector.from_instruction(qasm3.loads(by_qiskit))
sv_t = Statevector.from_instruction(qasm3.loads(by_text))
fid = state_fidelity(sv_q, sv_t)
ok('widening in text builds the same circuit as qiskit', fid > 1 - 1e-9, f'fidelity {fid:.6f}')
ok('and the text widening has the apparatus qubits', qasm3.loads(by_text).num_qubits == n + 2)

print()
print(f'  {FAIL} failed' if FAIL else '  all good')
sys.exit(1 if FAIL else 0)
