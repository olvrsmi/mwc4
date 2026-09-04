// auth.mjs - the signature checks the whole identity scheme rests on.
//
//   npm run test:auth
//
// No network, no Telegram, no server. The Telegram hashes below are computed
// here the long way round - written out by hand from the documented recipe
// rather than by calling dataCheckString - so that a bug in the module cannot
// quietly agree with itself and pass.

import { createHash, createHmac } from 'node:crypto'

import {
  checkTelegramAuth, dataCheckString, signSubject, readSubject, cookieFrom,
  setCookie, validSubject, newAnonSubject, telegramSubject, COOKIE,
} from '../host/auth.mjs'

let failures = 0
let passes = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passes += 1; return console.log(`  pass  ${name}`) }
  failures += 1
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
const section = (name) => console.log(`\n  -- ${name}`)

const TOKEN = '123456:AAHkqL5Nn0pWq3vZzY7bXcDeFgHiJkLmNoP'
const SECRET = 'a-server-secret'
const NOW = 1_757_000_000_000            // fixed, so auth_date arithmetic is exact
const now = () => NOW

/** The recipe from Telegram's docs, spelled out, as an independent oracle. */
function telegramHash (fields, token) {
  const pairs = []
  for (const key of Object.keys(fields).sort()) pairs.push(key + '=' + fields[key])
  const secretKey = createHash('sha256').update(token).digest()
  return createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex')
}

const person = {
  id: 5657145687,
  first_name: 'Ada',
  username: 'ada',
  photo_url: 'https://t.me/i/userpic/320/ada.jpg',
  auth_date: Math.floor(NOW / 1000) - 60,
}
const signedIn = (over = {}) => {
  const fields = { ...person, ...over }
  return { ...fields, hash: telegramHash(fields, TOKEN) }
}

// ---------------------------------------------------------------------------
section('the Telegram Login Widget')
// ---------------------------------------------------------------------------

ok('a genuine login is accepted', checkTelegramAuth(signedIn(), TOKEN, { now }))

ok('the data-check-string omits the hash and sorts by key',
   dataCheckString(signedIn()) ===
     ['auth_date=' + person.auth_date, 'first_name=Ada', 'id=' + person.id,
      'photo_url=' + person.photo_url, 'username=ada'].join('\n'))

{
  // the attack this whole check exists to stop: claim to be someone else
  const stolen = { ...signedIn(), id: 999 }
  ok('a tampered id is rejected', !checkTelegramAuth(stolen, TOKEN, { now }))
}
{
  const stolen = { ...signedIn(), first_name: 'Grace' }
  ok('a tampered name is rejected', !checkTelegramAuth(stolen, TOKEN, { now }))
}
{
  const forged = { ...signedIn(), hash: 'f'.repeat(64) }
  ok('an invented hash is rejected', !checkTelegramAuth(forged, TOKEN, { now }))
}
ok('a hash of the wrong length is rejected',
   !checkTelegramAuth({ ...signedIn(), hash: 'abcd' }, TOKEN, { now }))
ok('a missing hash is rejected', !checkTelegramAuth({ ...person }, TOKEN, { now }))
ok('a hash signed by another bot is rejected',
   !checkTelegramAuth({ ...person, hash: telegramHash(person, '999:OTHERBOT') }, TOKEN, { now }))

// freshness: a captured payload must not be a key for ever
ok('a stale login is rejected',
   !checkTelegramAuth(signedIn({ auth_date: Math.floor(NOW / 1000) - 86401 }), TOKEN, { now }))
ok('a login just inside the window is accepted',
   checkTelegramAuth(signedIn({ auth_date: Math.floor(NOW / 1000) - 86000 }), TOKEN, { now }))
ok('a login dated far in the future is rejected',
   !checkTelegramAuth(signedIn({ auth_date: Math.floor(NOW / 1000) + 3600 }), TOKEN, { now }))
ok('small clock skew is tolerated',
   checkTelegramAuth(signedIn({ auth_date: Math.floor(NOW / 1000) + 30 }), TOKEN, { now }))
ok('a missing auth_date is rejected',
   !checkTelegramAuth({ id: 5, first_name: 'A', hash: 'x'.repeat(64) }, TOKEN, { now }))

ok('nonsense in is false out, not a throw',
   !checkTelegramAuth(null, TOKEN, { now }) && !checkTelegramAuth('nope', TOKEN, { now }))
{
  let threw = false
  try { checkTelegramAuth(signedIn(), '') } catch { threw = true }
  ok('no bot token to check against is a throw, not a pass', threw)
}

// ---------------------------------------------------------------------------
section('the session cookie')
// ---------------------------------------------------------------------------

const mine = signSubject('tg5657145687', SECRET, { now })
ok('a cookie it wrote is believed', readSubject(mine, SECRET, { now }) === 'tg5657145687')
ok('a cookie signed with another secret is not',
   readSubject(signSubject('tg5657145687', 'other', { now }), SECRET, { now }) === null)
ok('the subject cannot be edited in place',
   readSubject(mine.replace('tg5657145687', 'tg000000009'), SECRET, { now }) === null)
ok('the signature cannot be invented',
   readSubject(mine.slice(0, mine.lastIndexOf('.') + 1) + 'a'.repeat(64), SECRET, { now }) === null)
ok('a truncated cookie is rejected', readSubject('v1.tg5.123', SECRET, { now }) === null)
ok('an empty cookie is rejected', readSubject('', SECRET, { now }) === null)
ok('a cookie from another version is rejected',
   readSubject('v0' + mine.slice(2), SECRET, { now }) === null)
ok('an expired cookie is rejected',
   readSubject(mine, SECRET, { now: () => NOW + 401 * 86400e3 }) === null)
ok('an anonymous subject round-trips',
   readSubject(signSubject('web0123456789abcdef', SECRET, { now }), SECRET, { now }) === 'web0123456789abcdef')

// ---------------------------------------------------------------------------
section('what may be a subject')
// ---------------------------------------------------------------------------

ok('a Telegram subject is one', validSubject('tg5657145687'))
ok('an anonymous subject is one', validSubject(newAnonSubject()))
ok('a new anonymous subject is not guessable', newAnonSubject() !== newAnonSubject())
ok('telegramSubject namespaces the user id', telegramSubject(42) === 'tg42')
// the store keys files by this string, so a subject is also a file name
for (const bad of ['../../etc/passwd', 'tg', 'tgabc', 'web', 'webzz', '', 'tg5/x', 'tg 5',
                   'TG5', 'tg5.json', null, undefined, 5, {}]) {
  ok(`${JSON.stringify(bad)} is not a subject`, !validSubject(bad))
}
{
  let threw = false
  try { signSubject('../etc/passwd', SECRET) } catch { threw = true }
  ok('signing a non-subject is a throw', threw)
}
{
  let threw = false
  try { signSubject('tg5', '') } catch { threw = true }
  ok('signing with no secret is a throw', threw)
}

// ---------------------------------------------------------------------------
section('cookie headers')
// ---------------------------------------------------------------------------

ok('the named cookie is found among others',
   cookieFrom(`other=1; ${COOKIE}=${mine}; last=2`) === mine)
ok('a lone cookie is found', cookieFrom(`${COOKIE}=${mine}`) === mine)
ok('a cookie whose name is a suffix is not mistaken for it',
   cookieFrom(`not${COOKIE}=hijack`) === null)
ok('no header is null', cookieFrom(undefined) === null)
ok('a header without it is null', cookieFrom('a=1; b=2') === null)
ok('a percent-encoded value comes back whole',
   cookieFrom(`${COOKIE}=${encodeURIComponent('a b')}`) === 'a b')

const header = setCookie(mine)
ok('the cookie is HttpOnly', /HttpOnly/.test(header))
ok('the cookie is SameSite=Lax', /SameSite=Lax/.test(header))
ok('the cookie is Secure by default', /Secure/.test(header))
ok('the cookie can drop Secure for plain-HTTP localhost',
   !/Secure/.test(setCookie(mine, { secure: false })))

console.log(`\n  ${passes} passed${failures ? `, ${failures} FAILED` : ', all good'}\n`)
process.exit(failures ? 1 : 0)
