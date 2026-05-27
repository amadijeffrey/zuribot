#!/usr/bin/env bash
#
# Local development wrapper around docker compose. Brings up the full stack
# (app + in-process workers, redis, caddy) plus a local Postgres, then applies the Prisma
# schema. Run from the repo root:
#
#   ./scripts/dev.sh            # bring up + push schema (default: 'up')
#   ./scripts/dev.sh logs       # tail all service logs
#   ./scripts/dev.sh down       # stop and remove containers (keeps volumes)
#   ./scripts/dev.sh reset      # stop and DELETE local db / redis / caddy data
#   ./scripts/dev.sh seed       # run db:seed inside the app container
#   ./scripts/dev.sh <anything> # passed through to docker compose

set -euo pipefail

cd "$(dirname "$0")/.."

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarn:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }

if [[ ! -f .env ]]; then
  warn ".env missing — copy .env.example to .env and fill in dummy values for"
  warn "WhatsApp / Paystack / ADMIN_API_KEY (zod schema requires them to be set)"
  exit 1
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)

cmd="${1:-up}"
shift || true

case "$cmd" in
  up)
    info "Building images"
    "${COMPOSE[@]}" build
    info "Starting stack"
    "${COMPOSE[@]}" up -d
    info "Waiting for db to be healthy"
    "${COMPOSE[@]}" exec -T db sh -c 'until pg_isready -U zuribot -d zuribot >/dev/null 2>&1; do sleep 1; done'
    info "Applying Prisma schema to local db"
    "${COMPOSE[@]}" exec -T app npx prisma db push
    "${COMPOSE[@]}" ps

    cat <<EOF

${GREEN}Dev stack is up.${RESET}

  App (direct):    http://localhost:3000
  App (via Caddy): https://localhost          # self-signed cert from Caddy's local CA
                                              # browser: trust Caddy's root once, OR use curl -k
  Postgres:        postgresql://zuribot:zuribot@localhost:5432/zuribot

  Logs:            ./scripts/dev.sh logs
  Stop:            ./scripts/dev.sh down
  Wipe data:       ./scripts/dev.sh reset

EOF
    ;;

  logs)
    "${COMPOSE[@]}" logs -f --tail=200 "$@"
    ;;

  down)
    "${COMPOSE[@]}" down
    ;;

  reset)
    warn "this deletes local Postgres data, Redis AOF, and Caddy certs"
    read -r -p "continue? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || exit 0
    "${COMPOSE[@]}" down -v
    ;;

  seed)
    "${COMPOSE[@]}" exec -T app npm run db:seed
    ;;

  *)
    exec "${COMPOSE[@]}" "$cmd" "$@"
    ;;
esac
