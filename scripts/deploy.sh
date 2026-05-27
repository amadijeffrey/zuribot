#!/usr/bin/env bash
#
# Pull the latest code and roll the stack. Run from the repo root:
#
#   ./scripts/deploy.sh
#
# Pass SCHEMA=1 if prisma/schema.prisma changed in this deploy.

set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

[[ -f docker-compose.yml ]] || die "run from the repo root"
[[ -f .env ]]               || die ".env missing"

info "Pulling latest code"
git pull --ff-only

info "Building images"
docker compose build

info "Recreating changed services"
docker compose up -d

if [[ "${SCHEMA:-}" == "1" ]]; then
  info "Applying Prisma schema changes"
  docker compose exec -T app npx prisma db push
fi

info "Status"
docker compose ps
