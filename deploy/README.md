# Putting it on a box

One Node process behind Caddy, run by systemd. Three config files and the
commands below — there are no deploy scripts to go wrong, and nothing here is
clever enough to need explaining twice.

**Hetzner CX22 (x86), Ubuntu 24.04.** Not an ARM CAX: `@napi-rs/canvas` ships
arm64 builds, but the optional Python engine means qiskit-aer on ARM, and x86
removes that variable for nothing.

Everything lives in one directory, owned by one user:

```
/opt/mackenziewalk          the clone
/opt/mackenziewalk/.env     secrets, 0600
/opt/mackenziewalk/state    saved games and charts - the only irreplaceable thing
/opt/mackenziewalk/backups  nightly tar, 14 kept
```

`state/` is inside the clone and gitignored, so `git pull` cannot touch it and
there is no second directory to keep in step.

## Before the box

Point the domain at the server's IP (an `A` record, and `AAAA` if you want v6),
and wait for it to resolve. Caddy asks Let's Encrypt for the certificate on
first start and that only works once DNS is live.

Make a **new** bot with @BotFather. Telegram allows exactly one long poll per
token and a second evicts the first, so the box and your laptop cannot share
one — the laptop keeps `TELEGRAM_BOT_TOKEN_LOCAL` with `MW_LOCAL=1`.

Then, still in BotFather, `/setdomain` on the new bot, set to the domain above.

> Without `/setdomain` the Login Widget renders and then silently refuses to
> sign anyone in. It is the most likely thing to go wrong, and it produces no
> error anywhere. Do it before you wonder why login does nothing.

## Setting up, once

As root. First the domain, once, in this shell — everything below uses it, so
set it to yours before you paste anything:

```bash
DOMAIN=mwc.example.com; case $DOMAIN in *example.com) echo "^^ not yours - change it";; esac
```

Left as it is, that domain fails at Let's Encrypt and the site answers every
browser with `ERR_SSL_PROTOCOL_ERROR` — which is why it says so out loud rather
than waiting to be found. If you reconnect part-way through, set it again. Then:

```bash
# node 20, to match .nvmrc
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git ufw

# caddy, from its own repo - it is not in Ubuntu's
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

adduser --system --group --home /opt/mackenziewalk mw
sudo -u mw git clone https://github.com/olvrsmi/mwc4 /opt/mackenziewalk
cd /opt/mackenziewalk && sudo -u mw npm ci --omit=dev
```

Write `/opt/mackenziewalk/.env` (see `.env.example` for the rest):

```
MW_MODEL=http
MW_MOTH_KEY=moth_...            # a key made for this box, not the laptop's
MW_STATE_DIR=/opt/mackenziewalk/state
PORT=5090
TELEGRAM_BOT_TOKEN=...          # the new production bot
MW_BOT_USERNAME=...             # without the @, for the login widget
MW_SECRET=...                   # openssl rand -hex 32
MW_PUBLIC_URL=https://...       # the same $DOMAIN, and the same one BotFather has
MW_TRUST_PROXY=1                # Caddy sets X-Forwarded-For; nothing else can reach it
```

Three places have to name the same domain and none of them will tell you if
they disagree: the Caddy site block, `MW_PUBLIC_URL`, and BotFather's
`/setdomain`. Caddy fails visibly. The other two fail silently — a cookie that
is not marked Secure, and a login widget that renders and signs nobody in.

```bash
chown mw:mw /opt/mackenziewalk/.env && chmod 600 /opt/mackenziewalk/.env
```

Check it can actually run before asking systemd to keep it running. `doctor`
reports the node version, whether the chart library can draw on this arch, and
what each physics backend is missing:

```bash
sudo -u mw npm run doctor --prefix /opt/mackenziewalk
```

Then start it:

```bash
cp /opt/mackenziewalk/deploy/mackenziewalk.service /etc/systemd/system/
cp /opt/mackenziewalk/deploy/mackenziewalk-backup.service /etc/systemd/system/
cp /opt/mackenziewalk/deploy/mackenziewalk-backup.timer /etc/systemd/system/

# Everything in deploy/ is a template, read and never written: editing one in
# place leaves the clone dirty and the next git pull awkward. The domain goes
# in on the way past.
sed "s/game\.example\.com/$DOMAIN/" /opt/mackenziewalk/deploy/Caddyfile > /etc/caddy/Caddyfile
```

Look at what that produced before starting anything. This one line is the
difference between a working site and a browser saying the connection is not
secure, and nothing downstream will tell you it is wrong:

```bash
awk '!/^[[:space:]]*#/ && NF {print; exit}' /etc/caddy/Caddyfile
```

That prints the site address line — the first thing in the file that is not a
comment. It must be your domain. Then check the whole file parses, so a typo
cannot take Caddy down on reload:

```bash
caddy validate --config /etc/caddy/Caddyfile
```

```bash
systemctl daemon-reload
systemctl enable --now mackenziewalk mackenziewalk-backup.timer
systemctl reload caddy

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Watch the first boot. The banner prints the model, and for `MW_MODEL=http` a
`moth` line saying whether the engine is reachable and enabled — that check is
read-only and spends no credits:

```bash
journalctl -u mackenziewalk -f
```

## Deploying a change

```bash
cd /opt/mackenziewalk && sudo -u mw git pull && sudo -u mw npm ci --omit=dev
systemctl restart mackenziewalk
journalctl -u mackenziewalk -n 40
```

The process drains the turns in flight on SIGTERM, so a restart does not cost
anyone the step they were paying for. Saved games are written atomically in any
case, so even a hard kill loses at most a message someone was reading.

## Deploying from a push

`.github/workflows/deploy.yml` runs `npm test` on every push and pull request,
and on a green build of `main` opens one ssh connection to the box. It sends no
command: the deploy key is pinned to a forced command, so that connection runs
`/usr/local/bin/mw-deploy` and nothing else. A leaked secret is a stranger who
can redeploy main — it is not a shell on your server.

Four steps, three of them yours alone. **The private key must never be pasted
anywhere but GitHub's own secrets page**, so generate it yourself rather than
having anything else do it for you.

**1. Make a key for CI, on your laptop.** Its own key, not one you use:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mwc-deploy -C "github actions mwc4" -N ""
```

**2. Pin it on the box**, as root. This adds a *second* key — your own key in
`authorized_keys` is untouched and keeps its normal shell:

```bash
cp /opt/mackenziewalk/deploy/mw-deploy /usr/local/bin/ && chmod 755 /usr/local/bin/mw-deploy
```

Then append one line to `/root/.ssh/authorized_keys`, with the contents of
`~/.ssh/mwc-deploy.pub` where the key goes:

```
command="/usr/local/bin/mw-deploy",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... github actions mwc4
```

**3. Pin the box's host key**, so the runner cannot be talked into handing the
key to something else. On your laptop:

```bash
ssh-keyscan -t ed25519 mwc.oliversmith.cc
```

Check the fingerprint of what comes back against the box's own, which you can
read while you are still logged in — `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

**4. Add three secrets** in the repository, under Settings → Secrets and
variables → Actions. Only you can do this:

| Secret | What goes in it |
|---|---|
| `DEPLOY_KEY` | the whole of `~/.ssh/mwc-deploy` — the private half, including the BEGIN and END lines |
| `DEPLOY_HOST` | `mwc.oliversmith.cc`, or the box's IP |
| `DEPLOY_KNOWN_HOSTS` | the line `ssh-keyscan` printed |

Then check it before trusting it. From your laptop, this should print a deploy,
not give you a prompt:

```bash
ssh -i ~/.ssh/mwc-deploy root@mwc.oliversmith.cc whoami
```

It ignores `whoami` and deploys. That is the forced command working, and it is
the thing worth confirming by hand: if it gives you a shell, the
`command="..."` prefix did not take, and the key is far more powerful than it
should be.

`mw-deploy` does `git reset --hard origin/main` rather than a pull, so the box
mirrors main and cannot be blocked by anything edited in place — which is how
the Caddyfile got stuck the first time. Only tracked files are touched: `.env`,
`state/` and `/etc/caddy/Caddyfile` are ignored or outside the clone, and stay
as they are. It then restarts the service and waits for `/api/health` to answer,
failing the workflow if it does not — so a red build means the site is down,
and a green one means it is up.

## Checking it from outside

```bash
curl https://$DOMAIN/api/health              # {"ok":true,"model":"...","bot":"polling"}
curl --max-time 5 http://<the box's IP>:5090/   # must NOT answer: the app is on loopback
```

`bot` in that health line is the one thing that can be wrong without the process
dying: a rejected token or another poller holding it leaves the website serving
normally and says so there.

## When TLS does not come up

`ERR_SSL_PROTOCOL_ERROR` in a browser means Caddy is listening but has no
certificate for the name that was asked for — nearly always because the site
block names a different domain. It is worth knowing that this is **not** what a
missing or untrusted certificate looks like: that is a warning page you can
click through. A protocol error means nothing valid was spoken on 443 at all.

```bash
awk '!/^[[:space:]]*#/ && NF {print; exit}' /etc/caddy/Caddyfile
```

```bash
ss -lntp | grep -E ':(80|443|5090)'      # who is actually listening
```

```bash
journalctl -u caddy -n 80 --no-pager     # Caddy says exactly why ACME failed
```

- `caddy` on 80 and 443 with `node` on 127.0.0.1:5090 is the layout you want.
- `node` on 443 means the app was exposed directly and Caddy is not in the path.
- Nothing on 443 gives connection-refused rather than a protocol error, so if
  you are seeing this at all, Caddy is running.

Port 80 has to stay open. The certificate is issued over it and renewed over it
every couple of months, so closing it once the site is up works until it
silently doesn't.

## Getting a game back

```bash
systemctl stop mackenziewalk
tar xzf /opt/mackenziewalk/backups/state-YYYYMMDD-HHMMSS.tar.gz -C /opt/mackenziewalk
systemctl start mackenziewalk
```

A single game is one file: `state/tg<telegram user id>.json`. Choosing to keep a
guest game over a Telegram one leaves the replaced game beside it as
`tg<id>.<stamp>.bak`, so that is recoverable by hand too.

## The Python engine, if you ever want it

Not needed to run: `MW_MODEL=http` sends the physics to the Moth API and the box
needs nothing but Node. Adding the local engine is what drags in a Python
toolchain and two private repositories, so it is worth doing only once the site
is up and known good.

```bash
apt install -y python3-venv python3-dev build-essential
sudo -u mw python3 -m venv /opt/mackenziewalk/model/.venv
sudo -u mw /opt/mackenziewalk/model/.venv/bin/pip install -r /opt/mackenziewalk/model/requirements.txt
# QDrive and qdrive-api are private: rsync a checkout up, then
sudo -u mw /opt/mackenziewalk/model/.venv/bin/pip install -e /opt/mackenziewalk/vendor/QDrive
# and in .env:  MW_QDRIVE_API_SRC=/opt/mackenziewalk/vendor/qdrive-api/src
sudo -u mw npm run model-test --prefix /opt/mackenziewalk
```

Be clear about what switching `MW_MODEL` buys. The circuit a saved game carries
is a handle whose meaning belongs to the backend that made it — under `http` a
Moth asset id, under `local` whatever `engine.py` hands back — and nothing
converts between them. Flipping the setting lets **new** worlds start. Games
already inside a world do not survive the switch.
