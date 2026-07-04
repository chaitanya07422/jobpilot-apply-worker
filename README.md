# jobpilot-apply-worker

Playwright auto-apply worker for JobPilot. Consumes BullMQ queue `apply` from Redis, opens employer apply URLs, and updates MongoDB `apply_jobs` status.

Runs on a **home Dell Linux (x86_64)** PC — not on the API host.

| Phase | Status |
|-------|--------|
| Phase 1 — scaffold + CI/CD | **This repo** |
| Phase 2 — API enqueue on Accept | `jobpilot-backend` (not yet) |
| Phase 3 — Playwright open URL | Ready (`APPLY_MODE=open`) |
| Phase 4 — Greenhouse form fill | Later |

---

## One-time setup on the Dell

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm i -g pm2

# Clone (use your GitHub remote)
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:<you>/jobpilot-apply-worker.git
cd jobpilot-apply-worker

cp .env.example .env
# Edit .env — at minimum REDIS_HOST / REDIS_PORT for the API Redis

npm ci
npx playwright install --with-deps chromium

npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command
```

Disable sleep/suspend on the Dell so the worker stays online.

### `.env` (stays on the Dell only)

```bash
REDIS_HOST=...              # Tailscale IP, SSH tunnel 127.0.0.1, or cloud Redis
REDIS_PORT=6379
REDIS_PASSWORD=
MONGODB_URI=                # optional until API writes apply_jobs
APPLY_QUEUE_NAME=apply
APPLY_MODE=noop             # use "open" to enable Playwright navigation
PLAYWRIGHT_HEADLESS=true
CONCURRENCY=1
```

---

## CI/CD (auto-deploy on push to `main`)

Same pattern as `jobpilot-backend`: lint/build on GitHub, deploy on the Dell.

### Recommended: self-hosted runner (no public SSH)

1. Push this repo to GitHub.
2. On the Dell, install a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners) (Linux x64).
3. Run it as a service so it survives reboot.
4. In the GitHub repo: **Settings → Secrets and variables → Actions → Variables**
   - Name: `APP_DIR`
   - Value: absolute path to the clone, e.g. `/home/chaitu/apps/jobpilot-apply-worker`

Every push to `main`:

1. `lint-build` on `ubuntu-latest`
2. `deploy` on `self-hosted` → `git pull` → `npm ci` → build → `pm2 reload`

Secrets (Redis/Mongo) are **never** in GitHub — only in Dell `.env`.

### Optional: SSH deploy

See [`.github/workflows/deploy-ssh.yml`](.github/workflows/deploy-ssh.yml) (disabled by default). Prefer the self-hosted runner for a home PC.

---

## Local run

```bash
cp .env.example .env
# point REDIS_HOST at a local Redis if you have one
npm ci
npm run build
npm start
```

With `APPLY_MODE=noop`, the worker only logs and acknowledges queue jobs (safe until the API enqueues real work).

With `APPLY_MODE=open`, it launches Chromium and navigates to `applyUrl` (requires Playwright browsers installed).

---

## Queue payload (for Phase 2 API)

BullMQ job name: any (worker handles all jobs on the queue).  
Queue name: `apply` (or `APPLY_QUEUE_NAME`).

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
