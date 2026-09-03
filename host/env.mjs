// env.mjs - read .env before anything else looks at process.env.
//
// Its own module, imported first: ES module imports are evaluated before the
// importing module's body runs, so a loadEnv() call inside server.mjs would
// happen after the other modules had already read their settings.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
if (existsSync(path)) {
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    } else {
      // An unquoted value ends where a trailing comment begins. Without this,
      // `TELEGRAM_BOT_TOKEN=123:ABC # the deployed one` carries ' # the
      // deployed one' into the token, and Telegram answers 401 as though the
      // token itself were wrong. Quote the value to keep a literal hash.
      const hash = val.search(/\s#/)
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    if (process.env[key] === undefined) process.env[key] = val   // the real environment wins
  }
}
