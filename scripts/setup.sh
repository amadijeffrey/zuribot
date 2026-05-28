#!/usr/bin/env bash
#
# One-shot setup script for a fresh Ubuntu 22.04 VM.
# Run from the repo root after editing .env:
#
#   ./scripts/setup.sh
#
# Idempotent — safe to re-run. Does NOT modify SSH config or create users;
# see scripts/harden.sh for those.

set -euo pipefail

# --- helpers -----------------------------------------------------------------

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarn:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

# --- preflight ---------------------------------------------------------------

[[ -f docker-compose.yml ]] || die "run from the repo root (docker-compose.yml not found)"
[[ -f .env ]]               || die ".env not found — cp .env.example .env, fill it in, then re-run"

# DOMAIN must be set and not the placeholder
DOMAIN_VALUE=$(grep -E '^DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
[[ -n "$DOMAIN_VALUE" && "$DOMAIN_VALUE" != "yourdomain.com" ]] \
  || die "set DOMAIN= in .env to your real domain before running this script"

# .env should not be world-readable
chmod 600 .env

# --- system packages ---------------------------------------------------------

info "Updating apt cache"
$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  curl ca-certificates ufw fail2ban unattended-upgrades >/dev/null

# --- firewall ----------------------------------------------------------------

info "Configuring UFW (allow 22, 80, 443)"
$SUDO ufw default deny incoming >/dev/null
$SUDO ufw default allow outgoing >/dev/null
$SUDO ufw allow 22/tcp   >/dev/null
$SUDO ufw allow 80/tcp   >/dev/null
$SUDO ufw allow 443/tcp  >/dev/null
$SUDO ufw --force enable >/dev/null

# --- fail2ban + unattended upgrades ------------------------------------------

info "Enabling fail2ban + unattended security upgrades"
$SUDO systemctl enable --now fail2ban >/dev/null
$SUDO dpkg-reconfigure --priority=low --frontend=noninteractive unattended-upgrades >/dev/null 2>&1 || true

# --- docker ------------------------------------------------------------------

if ! command -v docker >/dev/null; then
  info "Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
fi

docker compose version >/dev/null 2>&1 \
  || die "docker compose plugin missing — reboot the VM and re-run this script"

# Add invoking user to docker group (no-op when running as root)
if [[ $EUID -ne 0 ]] && ! id -nG "$USER" | grep -qw docker; then
  info "Adding $USER to docker group"
  $SUDO usermod -aG docker "$USER"
  die "you were just added to the docker group — log out, log back in, then re-run this script"
fi

# --- docker log rotation -----------------------------------------------------

if [[ ! -f /etc/docker/daemon.json ]] || ! grep -q max-size /etc/docker/daemon.json; then
  info "Configuring Docker log rotation (50m x 5 files)"
  $SUDO mkdir -p /etc/docker
  printf '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5"}}\n' \
    | $SUDO tee /etc/docker/daemon.json >/dev/null
  $SUDO systemctl restart docker
fi

# --- build + start -----------------------------------------------------------

info "Building images"
docker compose build

info "Starting stack (app, caddy)"
docker compose up -d

info "Waiting for services to start"
sleep 8
docker compose ps

# --- prisma db push ----------------------------------------------------------

info "Applying Prisma schema to Supabase"
docker compose exec -T app npx prisma db push

if [[ "${SEED:-}" == "1" ]]; then
  info "Seeding database (SEED=1)"
  docker compose exec -T app npm run db:seed
else
  warn "skipping seed — re-run with SEED=1 ./scripts/setup.sh to seed"
fi

# --- done --------------------------------------------------------------------

cat <<EOF

${GREEN}Setup complete.${RESET}

  Caddy is now obtaining a TLS cert for ${DOMAIN_VALUE}.
  Watch progress:    docker compose logs -f caddy
  Verify end-to-end: curl -I https://${DOMAIN_VALUE}

  Next:
    • Configure WhatsApp + Paystack webhooks to https://${DOMAIN_VALUE}/...
    • Set up backups: see scripts/backup-db.sh and DEPLOYMENT.md §9
    • (Optional) Harden SSH: see scripts/harden.sh
EOF
