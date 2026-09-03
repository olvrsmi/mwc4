// qasm.mjs - the one piece of circuit surgery done without qiskit.
//
// When a player invests, their qubit joins the running circuit: the n-qubit
// circuit so far becomes an (n + 2)-qubit one with the apparatus at n and a
// hidden qubit behind it at n + 1. Locally model/engine.py does this with
// qiskit. Over HTTP there is no qiskit, but the circuit travels as QASM3 text
// and the change is small enough to make in the text itself: widen the
// register declaration and put the preparation right after it. The prepared
// qubits are disjoint from the world's, so the gates commute and the result is
// the same circuit engine.py would have built.
//
//   RY(arccos c) on the hidden qubit, then CNOT onto the apparatus
//       -> apparatus is mixed on +Z with |r| = c
//   RY/RZ on the apparatus
//       -> rotates the axis; eigenvalues, hence |r|, are preserved

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const unit = (d) => {
  const v = (d || [0, 0, 1]).map(Number)
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 1e-9 ? v.map((x) => x / n) : [0, 0, 1]
}
// a float literal every QASM3 parser accepts: never a bare integer
const f = (x) => {
  let s = String(x)
  if (!/[.e]/i.test(s)) s += '.0'
  return s
}

const DECL = /^qubit\[(\d+)\]\s+([A-Za-z_]\w*)\s*;[^\S\n]*$/m

/** An empty circuit on n qubits. */
export const blankQasm = (n) => `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[${n}] q;\n`

/** How many qubits a QASM3 text declares, or null if it cannot be told. */
export function qubitCount (qasm) {
  const m = String(qasm).match(DECL)
  return m ? Number(m[1]) : null
}

/** The circuit so far on n qubits, widened to carry the apparatus. */
export function widenQasm (qasm, n, direction, coherence) {
  const src = String(qasm)
  const m = src.match(DECL)
  if (!m) throw new Error('widenQasm: no qubit register declaration found')
  if (Number(m[1]) !== n) throw new Error(`widenQasm: circuit has ${m[1]} qubits, expected ${n}`)
  const reg = m[2]
  const c = clamp(Number(coherence ?? 1), 0, 1)
  const d = unit(direction)
  const prep = [
    `ry(${f(Math.acos(c))}) ${reg}[${n + 1}];`,
    `cx ${reg}[${n + 1}], ${reg}[${n}];`,
    `ry(${f(Math.acos(clamp(d[2], -1, 1)))}) ${reg}[${n}];`,
    `rz(${f(Math.atan2(d[1], d[0]))}) ${reg}[${n}];`,
  ]
  return src.replace(m[0], `qubit[${n + 2}] ${reg};\n${prep.join('\n')}`)
}
