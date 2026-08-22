#!/usr/bin/env bash
# Seeds the dashboard for local testing: 57 aspects (a dozen depleted, most of
# the tail under 100) plus a handful of items.
#
#   ./testing-seed.sh                       # posts to localhost:3000
#   HOST=http://192.168.0.162:3000 ./testing-seed.sh
#
# Minimums/maximums in the payload only take effect on a server that hasn't
# been seeded with targets yet — hit the refresh button in the dashboard header
# first if you want them re-applied.
set -euo pipefail

HOST="${HOST:-http://localhost:3000}"
SEED="$(dirname "$0")/testing-seed.json"

curl -fsS -X POST "$HOST/api/mc-update" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SEED"
echo
