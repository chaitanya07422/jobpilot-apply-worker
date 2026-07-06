# Dell self-hosted runner setup

User: `chaitu`  
LAN: `192.168.1.15`  
App: `/home/chaitu/apps/jobpilot-apply-worker`

## Part A — Worker app (if not done)

```bash
ssh chaitu@192.168.1.15
cd ~/apps/jobpilot-apply-worker

# .env must include:
#   REDIS_HOST=127.0.0.1
#   MONGODB_URI=<same Atlas URI as jobpilot-backend>
#   APPLY_MODE=noop
pm2 status
pm2 logs jobpilot-apply-worker --lines 10
```

You want: `[worker] listening on queue "apply"` (or at least no crash loop).

## Phase 2 — shared Redis via Tailscale

Accept enqueues BullMQ jobs on queue `apply`. Oracle and Dell must share **one Redis** (on the Dell), reached over **Tailscale**.

**Full checklist:** [TAILSCALE-REDIS.md](./TAILSCALE-REDIS.md)

Short version:

1. Install Tailscale on **Dell** and **Oracle**; note Dell’s `tailscale ip -4` (e.g. `100.x.x.x`).
2. On Dell Redis: `bind 127.0.0.1 100.x.x.x` + `requirepass …`, restart Redis.
3. Dell worker `.env`: `REDIS_HOST=127.0.0.1`, same password, `MONGODB_URI` = Atlas.
4. Oracle API `.env`: `REDIS_HOST=100.x.x.x`, same password, `APPLY_ENQUEUE_ENABLED=true`.
5. `pm2 reload` both; Accept a job → Dell worker logs + `apply_jobs.status=opened`.

Health check (from Mac on same Wi‑Fi, or on the Dell):

```bash
curl -s http://192.168.1.15:3100/health
# {"ok":true,"service":"jobpilot-apply-worker","queue":"apply","mode":"noop","worker":"ready","redis":"up"}
```

`ok: true` and HTTP 200 = healthy. `503` means worker still starting or Redis is down.

## Phase 4 — Greenhouse auto-apply

**Oracle `.env`:**
```bash
APPLY_WORKER_SECRET=<long random string>
```

**Dell worker `.env`:**
```bash
APPLY_MODE=greenhouse
APPLY_SUBMIT=false
API_PUBLIC_URL=https://jobpilot-api.duckdns.org
APPLY_WORKER_SECRET=<same as Oracle>
MONGODB_URI=<Atlas URI>
APPLY_DEFAULT_PHONE=+91...   # optional; many forms need phone
```

- `APPLY_SUBMIT=false` → fills form + uploads resume, status **opened**
- `APPLY_SUBMIT=true` → clicks Submit, status **applied**

After deploy: Accept a Greenhouse job → `pm2 logs jobpilot-apply-worker`.

```bash
pm2 save
pm2 startup
# run the sudo command it prints
pm2 save
```

---

## Part B — Self-hosted GitHub runner

### 1. On GitHub (Mac browser)

1. Open https://github.com/chaitanya07422/jobpilot-apply-worker
2. **Settings** → **Actions** → **Runners**
3. **New self-hosted runner**
4. Choose **Linux** + **x64**
5. Leave that page open — you need the commands with your token

### 2. On the Dell (SSH from Mac)

```bash
ssh chaitu@192.168.1.15
```

Create a folder for the runner (separate from the app):

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
```

**Copy the download + extract commands from the GitHub page** (they look like):

```bash
# Example only — use the exact URLs/token from YOUR GitHub page
curl -o actions-runner-linux-x64-2.xxx.xxx.tar.gz -L https://github.com/actions/runner/releases/download/...
tar xzf ./actions-runner-linux-x64-2.xxx.xxx.tar.gz
```

Configure (token is on the GitHub page, one-time use):

```bash
./config.sh --url https://github.com/chaitanya07422/jobpilot-apply-worker --token PASTE_TOKEN_FROM_GITHUB
```

When asked:

| Prompt | Answer |
|--------|--------|
| Runner group | Enter (default) |
| Runner name | `dell` (or Enter) |
| Labels | Enter (default) |
| Work folder | Enter (default `_work`) |

Install as a service (survives reboot and logout):

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

### 3. Check on GitHub

**Settings → Actions → Runners** should show runner **Idle** (green).

### 4. Set APP_DIR variable

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**:

| Name | Value |
|------|--------|
| `APP_DIR` | `/home/chaitu/apps/jobpilot-apply-worker` |

No SSH secrets needed for self-hosted deploy.

---

## Part C — Test auto-deploy

On your **Mac**:

```bash
cd /Users/Chaitanya/personal/jobpilot-apply-worker
git pull origin main
git commit --allow-empty -m "test: trigger Dell deploy"
git push origin main
```

Then open:

https://github.com/chaitanya07422/jobpilot-apply-worker/actions

You should see:

1. **Lint & Build** — green (runs on GitHub cloud)
2. **Deploy worker on Dell** — green (runs on your Dell)

On the Dell:

```bash
pm2 status
cd ~/apps/jobpilot-apply-worker && git log -1 --oneline
```

---

## If deploy fails

| Problem | Fix |
|---------|-----|
| Runner offline | `cd ~/actions-runner && sudo ./svc.sh start` |
| `APP_DIR` not set | Add repo variable `APP_DIR` |
| `cd: no such file` | Clone app to `/home/chaitu/apps/jobpilot-apply-worker` |
| Permission denied on git pull | `cd ~/apps/jobpilot-apply-worker && git status` — fix ownership |

---

## What you do day to day

```bash
# On Mac — edit code, then:
git add -A && git commit -m "your message" && git push origin main
```

Dell updates itself. No manual `git pull` on the Dell.
