# Shared Redis via Tailscale (Phase 2)

Oracle API and Dell apply-worker must use the **same Redis**.  
Redis stays on the **Dell**; Oracle reaches it over **Tailscale** (no port-forward on your home router).

```text
Oracle VM (jobpilot-backend)
        │
        │  Tailscale mesh (encrypted)
        ▼
Dell (100.x.x.x) ── Redis :6379
                 └── jobpilot-apply-worker (REDIS_HOST=127.0.0.1)
```

| Machine | Tailscale | Redis role |
|---------|-----------|------------|
| Dell (`chaitu`) | install + always on | **Runs** Redis; worker uses `127.0.0.1` |
| Oracle (`chaitu-server`) | install + always on | API uses Dell’s **Tailscale IP** as `REDIS_HOST` |
| Mac (optional) | install | only for `redis-cli` / health tests |

**Note:** Auth refresh tokens live in Redis. After you point Oracle at Dell Redis, existing sessions are invalid — users sign in again once.

---

## 1. Install Tailscale

### Dell

```bash
ssh chaitu@192.168.1.15
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the URL it prints, log in (Google/GitHub/etc.), approve the device.

```bash
tailscale status
tailscale ip -4
# example: 100.64.12.34   ← save this as DELL_TAILSCALE_IP
```

### Oracle VM

```bash
ssh ubuntu@<your-oracle-host>   # or however you usually SSH
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Approve in the same Tailscale account.

```bash
tailscale status
# Dell should appear as online
ping -c 2 $(tailscale ip -4)   # optional self-check
```

From Oracle, ping the Dell Tailscale IP:

```bash
ping -c 3 100.x.x.x
```

If ping fails, check both devices are **online** in https://login.tailscale.com/admin/machines and that ACLs allow them (default allow-all is fine for a personal account).

---

## 2. Secure Redis on the Dell

Generate a password (on Mac or Dell):

```bash
openssl rand -base64 24
# save as REDIS_PASSWORD
```

On the Dell, find Redis config (Ubuntu/Debian usually):

```bash
redis-cli ping
# PONG

# common paths:
ls /etc/redis/redis.conf
# or: ls /etc/redis/redis.conf /usr/local/etc/redis.conf
```

Edit as root (use your real Tailscale IP and password):

```bash
sudo nano /etc/redis/redis.conf
```

Set (or update) these lines:

```conf
# Listen on localhost (worker) + Tailscale only (Oracle)
bind 127.0.0.1 100.x.x.x

protected-mode yes
requirepass YOUR_LONG_RANDOM_PASSWORD

# Keep default port
port 6379
```

**Do not** use `bind 0.0.0.0` unless you also lock the firewall tightly.

Restart Redis:

```bash
sudo systemctl restart redis-server
# or: sudo systemctl restart redis
sudo systemctl status redis-server
```

Local check (password required now):

```bash
redis-cli -a 'YOUR_LONG_RANDOM_PASSWORD' ping
# PONG
```

Optional firewall (only Tailscale interface):

```bash
sudo ufw status
# if ufw is active:
sudo ufw allow in on tailscale0 to any port 6379 proto tcp
sudo ufw reload
```

---

## 3. Worker `.env` on Dell

`/home/chaitu/apps/jobpilot-apply-worker/.env`:

```bash
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_LONG_RANDOM_PASSWORD

MONGODB_URI=mongodb+srv://...   # same Atlas URI as jobpilot-backend
APPLY_QUEUE_NAME=apply
APPLY_MODE=noop
PLAYWRIGHT_HEADLESS=true
CONCURRENCY=1
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3100
```

Reload worker:

```bash
cd ~/apps/jobpilot-apply-worker
pm2 reload ecosystem.config.cjs --update-env
pm2 logs jobpilot-apply-worker --lines 20
```

Health:

```bash
curl -s http://127.0.0.1:3100/health
# "redis":"up"
```

---

## 4. Backend `.env` on Oracle

In the API app `.env` (same place as today):

```bash
REDIS_HOST=100.x.x.x
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_LONG_RANDOM_PASSWORD
APPLY_ENQUEUE_ENABLED=true
```

Use the Dell **Tailscale** IP from step 1 — **not** `192.168.1.15`.

Reload API:

```bash
pm2 reload jobpilot-api --update-env
# or whatever your process name is
pm2 logs jobpilot-api --lines 30
```

Health should show Redis up (if your health check includes Redis):

```bash
curl -s https://jobpilot-api.duckdns.org/api/v1/health
```

From Oracle, direct Redis check:

```bash
# if redis-cli installed:
redis-cli -h 100.x.x.x -a 'YOUR_LONG_RANDOM_PASSWORD' ping
```

---

## 5. End-to-end test

1. Sign in again (refresh tokens were on old Redis).
2. Accept a job in the app.
3. On Dell:

```bash
pm2 logs jobpilot-apply-worker --lines 30
# expect: [worker] job … applyJobId=… mode=noop
```

4. In MongoDB Atlas → `apply_jobs` → latest row `status: "opened"` (noop mode).
5. Suggestions API includes `"applyStatus":"opened"`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Oracle `ping` Dell Tailscale IP fails | Both `tailscale up`; devices online in admin console |
| `NOAUTH` / Redis auth errors | Same `REDIS_PASSWORD` on Oracle and Dell worker |
| `Connection refused` from Oracle | Redis `bind` includes Tailscale IP; Redis restarted |
| Worker healthy, Accept never runs on Dell | Oracle still on old `REDIS_HOST=127.0.0.1` — must be Dell Tailscale IP |
| Tailscale IP changed | Rare; update Oracle `REDIS_HOST` and Redis `bind` |
| Dell sleeps | Disable suspend so Tailscale + Redis stay up |

---

## Day-to-day

- Keep Tailscale **running** on Dell and Oracle (`sudo systemctl enable --now tailscaled`).
- Worker always uses `REDIS_HOST=127.0.0.1`.
- API always uses Dell’s Tailscale IP.
- You do **not** need to open port 6379 on your home router.
