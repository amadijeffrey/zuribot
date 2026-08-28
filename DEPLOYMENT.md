# ZuriBot — VM Deployment Guide

Deploy ZuriBot (Node.js API + Caddy) onto a single Linux VM using Docker Compose, with **PostgreSQL hosted on Supabase**. Tested on **Ubuntu 22.04 LTS** on Hetzner Cloud and DigitalOcean.

On the VM: `app`, `caddy`. Postgres lives in Supabase (managed). Caddy terminates TLS and proxies to the app on the Docker network — `app` has no host port binding.

---

## TL;DR

```bash
# 1. SSH to a fresh Ubuntu 22.04 VM
ssh root@<VM_IP>

# 2. (Optional) Harden SSH and create a non-root user
git clone <your-repo-url> /opt/zuribot
cd /opt/zuribot
./scripts/harden.sh           # logs out root; reconnect as deploy@<VM_IP>

# 3. Configure environment
cp .env.example .env
nano .env                     # set DOMAIN, DATABASE_URL, DIRECT_URL, secrets

# 4. One-shot install + deploy
./scripts/setup.sh            # SEED=1 ./scripts/setup.sh to also seed
```

That's it. The rest of this document explains what each step does and is reference material for ops.

---

## 1. Provision the VM

| Component | Minimum | Recommended |
|---|---|---|
| vCPU | 1 | 2 |
| RAM | 1 GB | 2 GB |
| Disk | 25 GB SSD | 40 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

**Hetzner**: `CX22` (2 vCPU / 4 GB / 40 GB, ~€4/mo).
**DigitalOcean**: `s-1vcpu-2gb` Basic Droplet (~$12/mo).

Pick a region close to your users **and to the Supabase project region**. Add your SSH public key at creation; do not use password auth. Note the public IPv4 address.

### Cloud firewall (configure in provider dashboard)

| Port | Protocol | Source |
|---|---|---|
| 22 | TCP | Your IP (or `0.0.0.0/0` if you must) |
| 80 | TCP | `0.0.0.0/0` |
| 443 | TCP | `0.0.0.0/0` |

`scripts/setup.sh` also configures UFW on the host with the same rules.

---

## 2. Set up Supabase (Postgres)

1. Create a project at <https://supabase.com>. Choose a region close to the VM.
2. Set a strong database password when prompted.
3. In **Project Settings → Database**, grab two connection strings:
   - **Connection pooling** (port `6543`, transaction mode) → `DATABASE_URL` in `.env`.
   - **Direct connection** (port `5432`) → `DIRECT_URL` in `.env`.
4. (Recommended) Under **Database → Network Restrictions**, allow-list the VM's IPv4 once you have it.

Format the URLs like this in `.env`:

```dotenv
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=15&pool_timeout=20"
DIRECT_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

`pgbouncer=true` is required on the pooler URL — Prisma disables prepared statements that don't survive transaction-mode pooling.

### Sizing `connection_limit`

`connection_limit=15` is correct **for this VM deployment and only for it**. The value is per `PrismaClient`, and a VM runs exactly one long-lived process holding exactly one client — so the app's ceiling against Supabase is 15 connections no matter how much traffic arrives.

That assumption does not hold on serverless. Each concurrent function instance is its own process with its own client and its own pool of 15, so *N* instances claim *15 × N* connections. A handful of simultaneous users is enough to exhaust the pooler; Prisma then waits `pool_timeout` seconds and throws `P2024`, and requests fail — often with no usable response, because the platform kills the invocation first.

**If you deploy to Vercel or any serverless target, set `connection_limit=1`.** Each instance serves one request at a time, so a larger pool buys nothing and only multiplies the connection count.

---

## 3. DNS

Point your domain's `A` record at the VM's public IPv4 **before** running `setup.sh`. Caddy needs ports 80/443 to be reachable on that domain to obtain a Let's Encrypt cert. Verify:

```bash
dig +short yourdomain.com
```

---

## 4. The scripts

All scripts live in [scripts/](scripts/) and are run from the repo root.

### `scripts/harden.sh` — optional SSH hardening (run as root)

Creates a `deploy` user, copies your SSH key over, disables root login and password auth, sets timezone to UTC.

```bash
sudo ./scripts/harden.sh
# log out, then: ssh deploy@<VM_IP>
```

Skip this if you're fine running as root or you've already hardened the box.

### `scripts/setup.sh` — one-shot install + deploy

Idempotent. Safe to re-run. Does:

1. Installs `ufw`, `fail2ban`, `unattended-upgrades`, `docker`.
2. Configures UFW (22/80/443) and enables fail2ban.
3. Configures Docker log rotation (50 MB × 5 files).
4. Validates `.env` (`DOMAIN` must be real, not the placeholder).
5. Builds the images and runs `docker compose up -d`.
6. Runs `prisma db push` against Supabase via `DIRECT_URL`.
7. Optionally seeds the DB (`SEED=1 ./scripts/setup.sh`).

If the script adds you to the `docker` group on first run, it tells you to log out and re-run. That's a one-time hop.

### `scripts/deploy.sh` — pull + roll the stack

```bash
./scripts/deploy.sh           # for code-only changes
SCHEMA=1 ./scripts/deploy.sh  # if prisma/schema.prisma changed
```

### `scripts/backup-db.sh` — ad-hoc Supabase dump to disk

Dumps via `DIRECT_URL` to `./backups/zuribot-<ts>.sql.gz`. Run on demand. See §8.

### `scripts/dev.sh` — local development stack

Brings up the full stack on your laptop using `docker-compose.dev.yml` as an override. Adds a local Postgres container (no Supabase needed), exposes the app on `127.0.0.1:3000`, and runs Caddy with `tls internal` so you can hit `https://localhost`. See §12.

---

## 5. Reverse proxy + HTTPS — how Caddy is wired

Caddy runs as the `caddy` service in `docker-compose.yml` and reads [Caddyfile](Caddyfile):

```caddy
{$DOMAIN} {
    encode zstd gzip
    reverse_proxy app:3000 {
        header_up X-Real-IP {remote_host}
    }
    log { output stdout; format console }
}
```

`{$DOMAIN}` is substituted from the `DOMAIN` env var in `.env`.

**First start (handled automatically by `setup.sh`):**

1. Caddy registers an ACME account with Let's Encrypt (stored in the `caddy_data` volume).
2. Requests a cert for `$DOMAIN`, solves an HTTP-01 challenge (Let's Encrypt hits `http://yourdomain.com/.well-known/acme-challenge/...`).
3. Writes the cert to `caddy_data` and starts serving HTTPS on `:443`, redirecting HTTP → HTTPS on `:80`.

**Renewals** happen automatically ~30 days before expiry. **Never `docker compose down -v`** — that wipes the `caddy_data` volume and triggers re-issuance, which counts against Let's Encrypt's rate limits (50 certs/domain/week).

Reload after editing the Caddyfile:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### Caddy gotchas

- **Cloudflare orange-cloud proxy** breaks HTTP-01. Use DNS-only ("grey cloud") during issuance, or rebuild the Caddy image with the `caddy-dns/cloudflare` module and use DNS-01.
- **Local dev / no public DNS** — Caddy falls back to its internal self-signed CA. Add `tls internal` to the Caddyfile or just run without Caddy.
- **502 Bad Gateway** — Caddy can reach the `caddy` network but `app` is down or unhealthy. Check `docker compose ps`.

---

## 6. Wire up webhooks

Once HTTPS is live:

- **WhatsApp Cloud API** — Meta developer console → callback URL `https://yourdomain.com/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`. Subscribe to `messages`.
- **Paystack** — Dashboard → Settings → Webhooks → `https://yourdomain.com/paystack/webhook`.

Watch logs while sending a test event:

```bash
docker compose logs -f app
```

---

## 7. Operations cheatsheet

```bash
# Status
docker compose ps

# Logs
docker compose logs -f --tail=200 app caddy

# Restart app (e.g. after .env change)
docker compose up -d --force-recreate app

# Reload Caddy after editing Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile

# Shell
docker compose exec app sh

# psql against Supabase
docker run --rm -it postgres:15-alpine psql "$DIRECT_URL"

# Update to latest code
./scripts/deploy.sh
```

---

## 8. Backups

### Supabase (managed)

Supabase takes daily automated backups on every plan. Verify in **Database → Backups**.

### Ad-hoc offsite dump

`scripts/backup-db.sh` dumps via `DIRECT_URL` to `./backups`, gzipped. Run on demand if you want a local copy beyond Supabase's managed backups. Push the resulting file to S3 / DO Spaces / Hetzner Storage Box manually if you want it offsite.

### Provider snapshots

Enable scheduled snapshots in Hetzner/DO — cheap insurance for the whole disk.

---

## 9. Monitoring & logs

- **App logs**: `docker compose logs app` — Winston writes to stdout only.
- **Caddy access logs**: `docker compose logs caddy` (every request with status + latency).
- **System**: `htop`, `df -h`, `docker stats`.
- **Uptime check**: configure UptimeRobot / BetterStack to hit `https://yourdomain.com/health` every minute.
- **Supabase**: dashboard shows DB CPU, connection count, slow queries.

### Log retention

`setup.sh` configures Docker's json-file driver at 50 MB × 5 files, so the captured stdout stream is capped at 250 MB per container and cannot fill the disk.

Note what that does *not* cover: Docker's rotation applies only to stdout/stderr. Any file the application writes inside its own filesystem is invisible to it. That is why on-disk logging is off unless `LOG_FILE_DIR` is set, and why the files it enables carry their own 20 MB × 5 bound — an unbounded log inside the container's writable layer would grow until the disk filled, with nothing to reclaim it.

Leave `LOG_FILE_DIR` unset here. `docker compose logs` is the supported way to read them.

### Watching the scheduled sweep

The sweep is the **only** path that revokes access: `invoice.payment_failed` moves a subscription to GRACE, and only `runExpirySweep` moves GRACE to EXPIRED. If it silently stops, members past expiry keep their access indefinitely and nothing else in the system notices.

Two detectors, because one is not enough:

1. **Resumed after a gap** — a successful run records `job_runs.cron-sweep` and alerts the admins if the previous success was more than 48h earlier. This cannot fire while the sweep is still dead, since nothing is running to check.
2. **Still dead** — `GET /ready` reports it, which is why the uptime monitor above is the real safety net:

```json
{ "checks": { "db": "ok", "sweep": "stale" }, "sweepLastSuccessAt": "2026-08-25T03:00:12.001Z" }
```

Configure the monitor to assert on `checks.sweep`, not just the HTTP status. The status stays 200 deliberately — a stale sweep does not mean the process cannot serve traffic, and 503ing would pull a healthy instance out of a load balancer for a scheduling problem.

---

## 10. Security checklist before going live

- [ ] `harden.sh` run (or equivalent done by hand) — root SSH disabled, password auth disabled.
- [ ] UFW + cloud firewall both only allow 22/80/443.
- [ ] `.env` is `chmod 600` (`setup.sh` enforces this).
- [ ] Supabase password is strong, Network Restrictions allow-list contains only the VM IP.
- [ ] `ADMIN_API_KEY` is a random 32-byte value (`openssl rand -hex 32`), not the default.
- [ ] `docker compose ps` shows host bindings only on `caddy` (80, 443) — never on `app`.
- [ ] TLS works (`curl -I https://yourdomain.com`).
- [ ] Webhooks in Meta + Paystack point to the HTTPS domain.
- [ ] Fail2ban active (`sudo fail2ban-client status sshd`).
- [ ] `CRON_SECRET` set, and the scheduled sweep actually runs (see §9).
- [ ] At least one **real, deliverable** address in the `admins` table — alerts go to every active row and nowhere else. Test databases are often seeded with unroutable fixtures (`@example.com`, `.test`), and a bounced alert is logged but never surfaced.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `setup.sh` says "log out and re-run" | First-time docker group add | Log out, log back in, re-run |
| `app` container restart loop | Bad env var or Supabase unreachable | `docker compose logs app`; verify `DATABASE_URL` + Supabase allow-list |
| `prisma db push` complains about prepared statements | Pooler URL missing `pgbouncer=true` | Add it to `DATABASE_URL`; `db push` itself uses `DIRECT_URL` |
| `too many connections` / Prisma `P2024` | Pool size mismatch, or more than one `PrismaClient` in the process | Keep `connection_limit=15` on the VM (`=1` on serverless — see §2); confirm nothing constructs its own client outside `src/config/database.ts`; or upgrade the Supabase plan |
| 502 from Caddy | App container down/unhealthy | `docker compose ps`; `docker compose exec app wget -qO- http://localhost:3000/health` |
| Caddy stuck "obtaining certificate" | DNS not pointed at VM, port 80 blocked, or Cloudflare proxy on | `dig +short yourdomain.com`; check firewalls; grey-cloud the record |
| Cert re-issued every deploy | `caddy_data` volume not persisting | `docker volume ls` should show `zuribot_caddy_data`; never `docker compose down -v` in prod |
| WhatsApp webhook verify fails | `WHATSAPP_VERIFY_TOKEN` mismatch | Match the value in Meta dashboard exactly |
| Paystack signature errors | Wrong `PAYSTACK_SECRET_KEY` (test vs live) | Use the live secret key in production |
| Disk filling | Docker images piling up | `docker image prune -af` |

---

## 12. Running locally (dev)

To verify the stack works end-to-end before deploying — or just to develop against the same containers prod uses — bring up a local override:

```bash
cp .env.example .env
# Fill in dummy values for WHATSAPP_*, PAYSTACK_*, ADMIN_API_KEY etc.
# (zod schema requires them to be set; they don't need to be real for testing)
# DATABASE_URL / DIRECT_URL / DOMAIN are overridden by the dev compose file,
# so you can leave those at the .env.example defaults.

./scripts/dev.sh
```

What this does (via [docker-compose.dev.yml](docker-compose.dev.yml)):

- Adds a local **Postgres 15** container at `localhost:5432` (user/pass/db all `zuribot`). Data persists in a named volume across restarts.
- Overrides `DATABASE_URL` and `DIRECT_URL` to point at the local db (no `pgbouncer=true`).
- Binds **app** to `127.0.0.1:3000` so you can hit it directly without going through Caddy.
- Swaps Caddy's config for [Caddyfile.dev](Caddyfile.dev), which uses `tls internal` — Caddy issues a cert signed by its own local CA. `https://localhost` works in `curl -k` immediately, or trust Caddy's root once in your browser.
- Runs `prisma db push` automatically against the local db on first start.

### Common dev commands

```bash
./scripts/dev.sh           # bring up + push schema
./scripts/dev.sh logs      # tail all services
./scripts/dev.sh logs app  # tail one service
./scripts/dev.sh seed      # run db:seed
./scripts/dev.sh down      # stop containers (keep data)
./scripts/dev.sh reset     # stop AND delete db + caddy volumes
```

Any subcommand the wrapper doesn't recognise gets passed through to `docker compose`, e.g. `./scripts/dev.sh exec app sh`.

### Trusting Caddy's local CA (optional)

If you want `https://localhost` to work without `-k` / browser warnings:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-ca.crt

# macOS:
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./caddy-local-ca.crt
```

You only need to do this once per machine.

---

## Appendix — When to graduate off this setup

This layout (one small VM + managed Postgres) comfortably handles a single-tenant WhatsApp gateway. Webhooks are processed synchronously in-process and acked after success, so WhatsApp's own retries cover transient failures. Likely upgrade triggers, in order:

1. **Synchronous processing makes webhook responses too slow** (risking WhatsApp timeouts/duplicate deliveries) → reintroduce a job queue so the webhook can ack fast and process out-of-band.
2. **App availability matters** → run two VMs behind the provider's load balancer.
