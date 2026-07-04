# jobpilot-apply-worker

Playwright auto-apply worker for JobPilot. Consumes BullMQ queue `apply` from Redis, opens employer apply URLs, and updates MongoDB `apply_jobs` status.

Runs on a **home Dell Linux (x86_64)** PC — not on the API host.

| Phase | Status |
|-------|--------|
| Phase 1 — scaffold + CI/CD | **This repo** |
| Phase 2 — API enqueue on Accept | `jobpilot-backend` (not yet) |
| Phase 3 — Playwright open URL | Ready (`APPLY_MODE=open`) |
| Phase 4 — Greenhouse form fill | Later |

**Repo:** https://github.com/chaitanya07422/jobpilot-apply-worker

---

## One-time setup on the Dell (`chaitu@192.168.1.15`)

From your Mac (same Wi‑Fi):

```bash
ssh chaitu@192.168.1.15
```

On the Dell:

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm i -g pm2

# Clone
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/chaitanya07422/jobpilot-apply-worker.git
cd jobpilot-apply-worker

cp .env.example .env
nano .env   # set REDIS_* (and MONGODB_URI when API is ready)

npm ci
npx playwright install --with-deps chromium

npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command
```

Disable sleep/suspend on the Dell.

### `.env` on Dell only (never commit)

```bash
REDIS_HOST=...
REDIS_PORT=6379
REDIS_PASSWORD=
MONGODB_URI=
APPLY_QUEUE_NAME=apply
APPLY_MODE=noop
PLAYWRIGHT_HEADLESS=true
CONCURRENCY=1
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3100
```

Health check (after deploy):

```bash
curl -s http://192.168.1.15:3100/health
# {"ok":true,"service":"jobpilot-apply-worker","queue":"apply","mode":"noop","worker":"ready","redis":"up"}
```

---

## CI/CD (same as Oracle backend)

Push to `main` → GitHub Actions lint/build → **SSH into Dell** → `git pull` + `npm ci` + build + `pm2 reload`.

### Important: GitHub cannot reach `192.168.1.15`

`192.168.1.15` is a **private LAN** address. GitHub’s runners are on the public internet, so `DELL_HOST` must be something they can reach:

1. **Router port-forward** TCP `22` (or another port) → `192.168.1.15:22`
2. **DuckDNS / dynamic DNS** hostname pointing at your home public IP
3. Set secret `DELL_HOST` to that hostname (e.g. `chaitu-dell.duckdns.org`), **not** `192.168.1.15`

Use key-only SSH (disable password login if you expose port 22).

### Dell identity (your machine)

| | LAN (Mac → Dell) | GitHub Actions → Dell |
|--|------------------|------------------------|
| User | `chaitu` | secret `DELL_USER` = `chaitu` |
| Host | `192.168.1.15` | secret `DELL_HOST` = **public** hostname (DuckDNS), **not** `192.168.1.15` |
| App dir | `/home/chaitu/apps/jobpilot-apply-worker` | secret `DELL_APP_DIR` = same path |

From Mac (same Wi‑Fi):

```bash
ssh chaitu@192.168.1.15
```

### GitHub secrets

Repo → **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Value |
|--------|--------|
| `DELL_HOST` | DuckDNS / public IP (GitHub **cannot** use `192.168.1.15`) |
| `DELL_USER` | `chaitu` |
| `DELL_SSH_KEY` | Private key (full PEM). Public key in Dell `~/.ssh/authorized_keys` |
| `DELL_APP_DIR` | `/home/chaitu/apps/jobpilot-apply-worker` |
| `DELL_SSH_PORT` | Optional, default `22` (use forwarded port if different) |

Also create environment **`production`** (Settings → Environments) if the workflow requires it (same as backend).

### Create SSH key on Mac (for Actions)

```bash
ssh-keygen -t ed25519 -C "github-actions-dell" -f ~/.ssh/jobpilot_dell_deploy -N ""
ssh-copy-id -i ~/.ssh/jobpilot_dell_deploy.pub chaitu@192.168.1.15

# Paste PRIVATE key into GitHub secret DELL_SSH_KEY:
cat ~/.ssh/jobpilot_dell_deploy
```

Test from Mac:

```bash
ssh -i ~/.ssh/jobpilot_dell_deploy chaitu@192.168.1.15
```

After port-forward + DuckDNS, test from outside (or rely on Actions).

---

## Local run

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

`APPLY_MODE=noop` — ack jobs only (Phase 1 default).  
`APPLY_MODE=open` — Playwright navigates to `applyUrl`.

---

## Queue payload (Phase 2 API)

```json
{
  "applyJobId": "mongoObjectId",
  "userId": "mongoObjectId",
  "jobId": "mongoObjectId",
  "applyUrl": "https://boards.greenhouse.io/...",
  "source": "greenhouse",
  "company": "Stripe",
  "role": "Backend Engineer"
}
```
