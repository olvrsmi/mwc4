// model-local.mjs - the physics, spoken to model/engine.py over stdio.
//
// One JSON request in on stdin, one JSON response out on stdout, then the
// process exits. Python startup is ~0.4s and a step is a second or so, which
// is fine for a game that only moves when the player does.
//
// MW_PYTHON overrides the interpreter. Otherwise a venv inside model/ is
// preferred, falling back to python3 on PATH. Whatever is used needs
// model/requirements.txt satisfied, and MW_QDRIVE_API_SRC pointing at a
// qdrive-api checkout's src/ (see model/engine.py).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MODEL_DIR = resolve(HERE, '..', 'model')
const ENGINE = join(MODEL_DIR, 'engine.py')

export function findPython () {
  if (process.env.MW_PYTHON) return process.env.MW_PYTHON
  for (const candidate of [join(MODEL_DIR, '.venv', 'bin', 'python3'),
                           join(MODEL_DIR, '.venv', 'Scripts', 'python.exe')]) {
    if (existsSync(candidate)) return candidate
  }
  return 'python3'
}

function runEngine (request, { python, timeoutMs, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [ENGINE], {
      cwd: MODEL_DIR,
      env: { ...process.env, PYTHONWARNINGS: 'ignore', ...env },
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`model timed out after ${timeoutMs}ms on op '${request.op}'`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`could not start python (${python}): ${e.message}\n` +
        'Set MW_PYTHON, or create model/.venv and install model/requirements.txt.'))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0 && !out.trim()) {
        const lines = err.trim().split('\n').filter(Boolean)
        const exc = [...lines].reverse().find((l) => /^\w+(\.\w+)*(Error|Exception):/.test(l.trim()))
        let hint = ''
        if (/ModuleNotFoundError: No module named/.test(err)) {
          hint = '\nThat interpreter is missing the model dependencies. ' +
                 'Install model/requirements.txt into it, or point MW_PYTHON elsewhere.'
        }
        return reject(new Error(`model (${python}) exited ${code}: ${exc || lines.slice(-1)[0] || 'no output'}${hint}`))
      }
      let parsed
      try { parsed = JSON.parse(out) } catch {
        return reject(new Error(`model returned unparseable output: ${out.trim().slice(0, 200)}` +
          (err.trim() ? ` | stderr: ${err.trim().slice(-200)}` : '')))
      }
      if (!parsed.ok) return reject(new Error(parsed.error || 'model reported failure'))
      resolvePromise(parsed)
    })
    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
  })
}

/**
 * The local backend. `worlds` is the list from specs.mjs, so every backend
 * offers the same worlds; only the stepping goes through Python.
 */
export function createLocalModel ({ worlds, python = findPython(), timeoutMs = Number(process.env.MW_MODEL_TIMEOUT || 120000), env = {} } = {}) {
  return {
    name: 'local',
    info: () => ({ python, engine: ENGINE, timeoutMs }),
    async worlds () {
      if (worlds) return worlds
      const r = await runEngine({ op: 'worlds' }, { python, timeoutMs, env })
      return r.worlds
    },
    async step ({ world, circuit = null, enter = null, couple = null }) {
      const out = await runEngine({ op: 'step', world, circuit, enter, couple }, { python, timeoutMs, env })
      return { circuit: out.circuit, r: out.r, apparatus: out.apparatus ?? null }
    },
  }
}
