// model-http.mjs - the physics, spoken to the Moth API's qdrive-api-v1 engine.
//
// The same steps the notebook takes: submit a job that applies the world's
// targets to the current circuit (chained in by asset id as `initial_circuit`),
// poll until it completes, read each qubit's <Z> from the tomography. The
// circuit never comes down the wire between ordinary steps - the handle the
// game carries is the output asset's id.
//
// The one exception is the step a player invests on. Their qubit has to join
// the circuit, which means the QASM3 does come down, is widened in text (see
// qasm.mjs), and goes back up as a new asset.
//
// The key is never logged. MW_MOTH_KEY holds it, or MW_MOTH_KEY_FILE names a
// file that does.

import { readFileSync } from 'node:fs'
import { blankQasm, widenQasm } from './qasm.mjs'
import { seedOf } from './specs.mjs'

export const DEFAULT_API = 'https://api.mothquantum.com'
export const DEFAULT_ENGINE = 'qdrive-api-v1'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function resolveMothKey (env = process.env) {
  if (env.MW_MOTH_KEY) return env.MW_MOTH_KEY.trim()
  if (env.MW_MOTH_KEY_FILE) return readFileSync(env.MW_MOTH_KEY_FILE, 'utf8').trim()
  throw new Error('no Moth API key: set MW_MOTH_KEY or MW_MOTH_KEY_FILE')
}

/**
 * The HTTP backend. `specs` is the Map from specs.mjs (the targets have to be
 * sent with every job), `worlds` the matching info list.
 */
export function createHttpModel ({
  specs, worlds, key,
  api = DEFAULT_API, engine = DEFAULT_ENGINE,
  fetch = globalThis.fetch,
  pollMs = { first: 300, max: 2000 },
  timeoutMs = 180000,
  log = () => {},
} = {}) {
  if (!specs) throw new Error('createHttpModel: specs is required')
  if (!key) throw new Error('createHttpModel: key is required')

  async function call (method, path, body, { raw = false } = {}) {
    const res = await fetch(api + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const textBody = await res.text()
    let parsed = textBody
    try { parsed = textBody ? JSON.parse(textBody) : null } catch { /* not json */ }
    if (!res.ok) {
      const detail = (parsed && typeof parsed === 'object' && (parsed.detail || parsed.title)) || String(textBody).slice(0, 300)
      throw Object.assign(new Error(`${res.status} ${method} ${path}: ${detail}`), { status: res.status, body: parsed })
    }
    return raw ? textBody : parsed
  }

  async function download (assetId) {
    const d = await call('GET', `/api/v1/assets/${assetId}/download`)
    const url = d && (d.download_url || d.url)
    if (!url) throw new Error(`asset ${assetId}: no download url in ${JSON.stringify(d).slice(0, 200)}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`asset ${assetId}: download ${res.status}`)
    return res.text()
  }

  async function upload (text, filename = 'circuit.qasm') {
    const bytes = Buffer.from(text, 'utf8')
    const created = await call('POST', '/api/v1/assets', {
      filename, content_type: 'text/plain', size_bytes: bytes.length,
    })
    const up = created.upload || {}
    // content type and length are signed into the url: send its headers verbatim
    const put = await fetch(up.url, { method: up.method || 'PUT', headers: up.headers || {}, body: bytes })
    if (!put.ok) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 200)}`)
    await call('POST', `/api/v1/assets/${created.asset_id}/complete`)
    return created.asset_id
  }

  async function poll (jobId) {
    const deadline = Date.now() + timeoutMs
    for (let wait = pollMs.first; ; wait = Math.min(pollMs.max, Math.round(wait * 1.5))) {
      const s = await call('GET', `/api/v1/jobs/${jobId}/status`)
      if (s.status === 'completed') return s
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new Error(`job ${jobId} ${s.status}: ${JSON.stringify(s.error || s).slice(0, 300)}`)
      }
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`)
      await sleep(wait)
    }
  }

  return {
    name: 'http',
    info: () => ({ api, engine }),
    /** Is the engine there and enabled? Read-only; spends nothing. */
    async check () {
      const e = await call('GET', `/api/v1/engines/${engine}`)
      return { engine_id: e.engine_id, enabled: e.enabled, credits_per_run: e.credits_per_run, version: e.version }
    },
    async worlds () { return worlds || [] },
    async step ({ world, circuit = null, enter = null, couple = null }) {
      const spec = specs.get(world)
      if (!spec) throw new Error(`http model: no specification '${world}'`)
      const n = spec.n
      let asset = circuit
      if (enter) {
        const qasm = asset ? await download(asset) : blankQasm(n)
        asset = await upload(widenQasm(qasm, n, enter.direction, enter.coherence))
        log('enter', { world, asset })
      }
      const targets = [...spec.targets]
      if (couple !== null && couple !== undefined) {
        const t = Number(couple)
        if (!(Number.isInteger(t) && t >= 0 && t < n)) throw new Error(`http model: holding ${couple} is outside ${world}'s ${n}`)
        if (!asset) throw new Error('http model: coupling with no apparatus in the circuit')
        targets.push({ expvals: { ZZ: 1.0 }, qubits: [n, t] })
      }
      const params = { seed: seedOf(spec), tomography: 1, targets }
      const body = { params }
      if (asset) body.input_files = { initial_circuit: asset }
      else params.n_qubits = n

      const job = await call('POST', `/api/v1/engines/${engine}/process`, body)
      const status = await poll(job.job_id)
      const res = status.result || {}
      const tomo = res.tomography || res.output?.tomography
      if (!tomo) throw new Error(`job ${job.job_id}: no tomography in result`)
      const read = (q, w) => clamp(Number(tomo[String(q)]?.[w] ?? 0), -1, 1)
      const z = Array.from({ length: n }, (_, q) => read(q, 'Z'))
      const apparatus = tomo[String(n)] ? ['X', 'Y', 'Z'].map((w) => read(n, w)) : null

      let outputs = status.outputs || []
      let out = outputs.find((o) => o.slot === 'circuit') || outputs[0]
      if (!out || !(out.output_asset_id || out.asset_id)) {
        const r = await call('GET', `/api/v1/jobs/${job.job_id}/result`)
        outputs = r.outputs || []
        out = outputs.find((o) => o.slot === 'circuit') || outputs[0]
      }
      const handle = out && (out.output_asset_id || out.asset_id)
      if (!handle) throw new Error(`job ${job.job_id}: no circuit output to chain from`)
      log('step', { world, job: job.job_id, asset: handle })
      return { circuit: handle, z, apparatus }
    },
  }
}
