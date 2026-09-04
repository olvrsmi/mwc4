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

As root:

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
MW_PUBLIC_URL=https://game.example.com
MW_TRUST_PROXY=1                # Caddy sets X-Forwarded-For; nothing else can reach it
```

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
sed -i 's/game.example.com/YOUR.DOMAIN/' /opt/mackenziewalk/deploy/Caddyfile
cp /opt/mackenziewalk/deploy/Caddyfile /etc/caddy/Caddyfile

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

## Checking it from outside

```bash
curl https://YOUR.DOMAIN/api/health          # {"ok":true,"model":"...","bot":"polling"}
curl --max-time 5 http://YOUR.IP:5090/       # must NOT answer: the app is on loopback
```

`bot` in that health line is the one thing that can be wrong without the process
dying: a rejected token or another poller holding it leaves the website serving
normally and says so there.

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
