# Goethe VPS Setup Guide — Puppeteer Bot with 20 Displays

**Stack:** TypeScript + Node.js + Puppeteer, 20x Xvfb/noVNC displays (PM2-managed), code-server, MongoDB, PM2.

**Server:** Hetzner Cloud, Ubuntu 24.04 (`noble`), IP `REDACTED`.

Run everything below over SSH, in order, as root or with sudo.

---

## 0. Before anything else — rotate leaked credentials

Real secrets were pasted into planning/chat sessions during setup. Treat all of these as compromised and rotate them:

1. **Telegram bot token** — in Telegram, message **@BotFather** → `/mybots` → your bot → **API Token** → **Revoke current token**. Put the new one in `.env`.
2. **MongoDB password** — set a new one when creating the app user in step 4.
3. **Any hardcoded credentials in source files** — at least one project file (`bookTest.ts`) has a real login email/password and a real proxy username/password hardcoded directly in the code. Move all of these into `.env` and reference `process.env.X` instead — hardcoded secrets end up in git history and are far more exposed than a `.env` file (which should be in `.gitignore`).
4. Confirm MongoDB's port `27017` isn't reachable from outside (`sudo ufw status` — it should NOT list 27017, since Mongo only needs to be reached from `localhost`).

---

## 1. System update & base packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential ufw software-properties-common \
  gnupg ca-certificates unzip
```

## 2. Puppeteer/Chromium system dependencies

Puppeteer/Chrome needs these libs to run headful (required here, since you're viewing sessions over VNC):

```bash
sudo apt install -y \
  fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0t64 libnspr4 libnss3 libx11-xcb1 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 xdg-utils \
  libvulkan1 libxss1
```

> Package names ending in `t64` are the newer 64-bit time_t builds Ubuntu 24.04 uses — apt substitutes these automatically even if you type the non-`t64` name. `libu2f-udev` and `libappindicator3-1` were dropped from the original list; they're not available/needed under those names on 24.04 and aren't required for headless/headful Chrome launching.

## 3. Google Chrome (Stable)

Your bot's code expects Chrome at `/usr/bin/google-chrome` specifically (not Chromium, not `google-chrome-stable`) — install it directly from Google's repo:

```bash
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable
```

Verify:
```bash
which google-chrome      # should print /usr/bin/google-chrome
google-chrome --version
```

## 4. Node.js (via NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 5. MongoDB

You're on Ubuntu 24.04 (`noble`), which ships a kernel well below `6.19` — so no version-pinning or workarounds are needed for the install itself. Clean install:

```bash
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

> **Known bug to watch for later:** MongoDB 8.0.5+ crashes on startup (SEGV/core-dump, usually 30–90 seconds after launch) on Linux kernel `6.19+`, due to a hardware Shadow Stack (CET) conflict with MongoDB's coroutine scheduler — tracked upstream as `SERVER-121912`. Ubuntu 24.04's stock kernel is unaffected, but if a future `apt upgrade` pulls in a newer HWE kernel line, or you move to a newer Ubuntu release, this can resurface. If `mongod` ever starts crash-looping again with a `core-dump`/`SEGV` result: check `uname -r` — if it's `6.19+`, pin MongoDB to version `8.0.4` exactly and add a systemd override (`sudo systemctl edit mongod`) with `Environment="GLIBC_TUNABLES=glibc.cpu.hwcaps=-SHSTK"`.

**Verify it's actually running before continuing** — fresh installs can fail silently:
```bash
sudo systemctl status mongod
```
Should show `active (running)`. If not:
```bash
sudo journalctl -u mongod -n 50 --no-pager
```
Common causes: data directory ownership (`sudo chown -R mongodb:mongodb /var/lib/mongodb` then `sudo systemctl restart mongod`), or a malformed `/etc/mongod.conf` (YAML is indentation-sensitive — a `security.authorization` value must be the literal word `enabled`, not `true`/`yes`/anything else, or mongod refuses to start with a `BadValue` error).

**Secure it — bind to localhost, then add auth:**

```bash
sudo nano /etc/mongod.conf
```
Confirm (default, but verify):
```yaml
net:
  bindIp: 127.0.0.1
```

Connect and create your app user with a fresh password:
```bash
mongosh
```
```js
use newdbpk
db.createUser({
  user: "saboor",
  pwd: "PASTE_A_NEW_STRONG_PASSWORD_HERE",
  roles: [{ role: "readWrite", db: "newdbpk" }]
})
exit
```

Enable auth:
```bash
sudo nano /etc/mongod.conf
```
```yaml
security:
  authorization: enabled
```
```bash
sudo systemctl restart mongod
sudo systemctl status mongod
```

New connection string: `mongodb://saboor:NEWPASSWORD@localhost:27017/newdbpk`

## 6. Displays — Xvfb + x11vnc + noVNC (x20), managed by PM2

Install the display stack:

```bash
sudo apt install -y xvfb x11vnc novnc websockify
```

Single script that starts all 20 displays, each with its own X server, VNC server, and noVNC web port:

```bash
sudo mkdir -p /opt/displays
sudo nano /opt/displays/start_displays.sh
```

```bash
#!/bin/bash
# Starts 20 virtual displays :1 - :20
# VNC ports: 5901-5920
# noVNC web ports: 6081-6100

for i in $(seq 1 20); do
  DISPLAY_NUM=$i
  VNC_PORT=$((5900 + i))
  WEB_PORT=$((6080 + i))

  Xvfb :$DISPLAY_NUM -screen 0 1280x800x24 &
  sleep 1

  x11vnc -display :$DISPLAY_NUM -forever -shared -rfbport $VNC_PORT -bg -nopw

  websockify --web=/usr/share/novnc/ $WEB_PORT localhost:$VNC_PORT &
done

echo "20 displays running. Access via http://SERVER_IP:6081 ... 6100/vnc.html"

wait
```

```bash
sudo chmod +x /opt/displays/start_displays.sh
```

> **The trailing `wait` is critical.** Without it, once the loop finishes (~20 seconds in), the script itself exits. Both PM2 and a naive systemd unit will interpret that exit as "the service died" and restart it — spawning a second full set of 20 Xvfb/x11vnc/websockify processes on displays that are already occupied, causing bind conflicts and an endless restart loop (this happened during setup: the service was restarting every ~27 seconds). `wait` blocks the script forever so PM2 only sees a real exit if something actually crashes.

Run it under PM2 (single process managing all 20 displays, matching how this was originally set up):

```bash
pm2 start /opt/displays/start_displays.sh --name displays --interpreter bash
pm2 save
```

If PM2 isn't yet configured to survive reboots on this box:
```bash
pm2 startup     # follow the printed command
```

**Verify stability** — watch for a couple minutes, restart count should stay low/at 0:
```bash
pm2 list
pm2 logs displays --lines 30
ps aux | grep Xvfb | wc -l    # should be exactly 20, staying at 20
```

**Firewall** — only open the noVNC ports you actually need externally, ideally IP-restricted if your provider supports it:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 6081:6100/tcp
sudo ufw enable
```

**Note on always-on behavior:** these displays run continuously (24/7), not on-demand — PM2 keeps all 20 Xvfb/x11vnc/websockify processes alive in the background regardless of whether the bot instances are actively using them. This was a deliberate choice, not a default to change.

## 7. code-server (remote VS Code)

```bash
curl -fsSL https://code-server.dev/install.sh | sh
```

```bash
mkdir -p ~/.config/code-server
nano ~/.config/code-server/config.yaml
```

```yaml
bind-addr: 0.0.0.0:8080
auth: password
password: SET_A_STRONG_PASSWORD_HERE
cert: false
```

```bash
sudo systemctl enable --now code-server@$USER
sudo ufw allow 8080/tcp
```

Access at `http://REDACTED:8080`.

## 8. PM2 + your project

```bash
sudo npm install -g pm2 typescript ts-node
```

Clone/copy your project to `/root/goethe-bot-india` (or your actual project path), then inside the project root:

```bash
npm install
```

`.env` (with rotated secrets, and hardcoded credentials from source files moved here too):
```dotenv
TELEGRAM_TOKEN=your_new_token_here
MONGO_URI=mongodb://saboor:NEWPASSWORD@localhost:27017/newdbpk
SERVER_IP=REDACTED
USE_PROXIES=true

# Move any hardcoded creds found in source (e.g. bookTest.ts) here instead:
TEST_ACCOUNT_EMAIL=...
TEST_ACCOUNT_PASSWORD=...
PROXY_HOST=pr.oxylabs.io:7777
PROXY_USERNAME=...
PROXY_PASSWORD=...
```

**Critical: when launching Puppeteer, `DISPLAY` must be uppercase and the rest of `process.env` must be preserved.** A bug during setup had this lowercase (`display` instead of `DISPLAY`), which Linux treats as a completely different, meaningless variable — Chrome silently got no display target and failed with `Missing X server or $DISPLAY`. Correct pattern in your launch code:

```javascript
const browser = await puppeteer.launch({
  headless: false,
  executablePath: "/usr/bin/google-chrome",
  userDataDir: "./profile",
  env: {
    ...process.env,
    DISPLAY: `:${browserNumber}`,   // must be uppercase; spread process.env so PATH etc. survive
  },
  args,
  defaultViewport: null,
});
```

(The `--display=` Chrome launch arg some code included does nothing — it's not a real Chromium flag. Only the `DISPLAY` env var controls this.)

1 Puppeteer instance : 1 display, launched via PM2 ecosystem file, each pinned to its own `DISPLAY`:

```bash
nano ecosystem.config.js
```

```js
module.exports = {
  apps: Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return {
      name: `bot-instance-${n}`,
      script: "dist/index.js", // or your actual entry point
      env: {
        DISPLAY: `:${n}`,
        INSTANCE_ID: `${n}`,
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    };
  }),
};
```

Build and launch:

```bash
npm run build   # tsc
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # if not already configured
```

Useful ongoing commands:
```bash
pm2 list
pm2 logs bot-instance-1
pm2 restart bot-instance-1
pm2 monit
```

## 9. Sanity checklist

- [ ] New Telegram token generated and in `.env`
- [ ] Mongo auth enabled, new password set, bound to `127.0.0.1`, not exposed via `ufw`
- [ ] All hardcoded credentials moved out of source files into `.env`
- [ ] `google-chrome --version` works, binary at `/usr/bin/google-chrome`
- [ ] `pm2 list` shows a `displays` process, `online`, low/stable restart count
- [ ] `ps aux | grep Xvfb | wc -l` returns exactly 20, staying at 20
- [ ] noVNC reachable at `http://REDACTED:6081` through `:6100`
- [ ] code-server reachable at `http://REDACTED:8080`, password auth on
- [ ] `pm2 list` shows 20 `bot-instance-N` processes online, each with correct `DISPLAY` (uppercase) in its env
- [ ] Puppeteer launch code uses `DISPLAY` (uppercase) and spreads `...process.env`
- [ ] `pm2 startup` + `pm2 save` done for both the displays process and bot instances, so everything survives a reboot
- [ ] `ufw status` only exposes the ports you intend (22, 6081-6100, 8080, plus whatever the bot needs)

---

## Appendix: issues hit during setup (for reference if they recur)

1. **Puppeteer/Chromium apt packages `t64` renaming + missing `libu2f-udev`** — Ubuntu 24.04 renamed several packages with a `t64` suffix; the original dependency list used pre-24.04 names and failed. Fixed in step 2 above.
2. **MongoDB apt repo 404 on newer/unreleased Ubuntu codenames** — `lsb_release -cs` returning an unrecognized codename (e.g. a dev-branch name) means MongoDB's repo has no matching `Release` file. Fix: hardcode a supported codename (`noble` for 24.04, `jammy` for 22.04) in the repo line instead of using `$(lsb_release -cs)`.
3. **MongoDB 7.0 has no `noble` build** — that combination always 404s; MongoDB 8.0 is the first line with `noble` support.
4. **MongoDB 8.0.5+ crash on kernel 6.19+ (`SERVER-121912`)** — see the callout in step 5. This is what ultimately motivated rebuilding this server from a newer/dev Ubuntu release down to 24.04, since 24.04's kernel doesn't trigger it.
5. **`mongod.conf` YAML errors** — `security.authorization` must be exactly `enabled` (not `true`), and indentation must be consistent (spaces, not tabs).
6. **Displays restart-looping every ~27 seconds under systemd** — caused by the script exiting after its startup loop finished, since none of the launched processes were waited on. Fixed by adding `wait` at the end of the script (see step 6).
7. **Displays moved from systemd to PM2** — matches how the original setup worked; a single PM2 process runs the same script.
8. **Puppeteer `DISPLAY` env var bug** — lowercase `display` key in the `env` object passed to `puppeteer.launch()` did nothing, since Linux env vars are case-sensitive. Must be uppercase `DISPLAY`, and `...process.env` must be spread in alongside it.
9. **Hardcoded credentials in source (`bookTest.ts`)** — real login and proxy credentials were committed directly in code rather than `.env`. Moved to `.env` per step 0 and step 8.

If any single piece here (proxy rotation logic, per-instance Chrome flags, resource limits for 20 concurrent Chromium instances) needs more detail, flag it and it can be expanded.