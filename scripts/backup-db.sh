#!/usr/bin/env bash
#
# Nightly Supabase Postgres dump to ./backups, gzipped, 14-day retention.
# Run from the repo root, typically via cron:
#
#   15 2 * * * /opt/zuribot/scripts/backup-db.sh >> /opt/zuribot/logs/backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "error: .env missing" >&2; exit 1; }

# Load DIRECT_URL from .env
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[[ -n "${DIRECT_URL:-}" ]] || { echo "error: DIRECT_URL not set in .env" >&2; exit 1; }

mkdir -p backups logs
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="backups/zuribot-${ts}.sql.gz"

echo "==> dumping to $out"
docker run --rm postgres:15-alpine pg_dump "$DIRECT_URL" | gzip > "$out"

echo "==> pruning dumps older than 14 days"
find backups -name 'zuribot-*.sql.gz' -mtime +14 -delete

echo "==> done ($(du -h "$out" | cut -f1))"
