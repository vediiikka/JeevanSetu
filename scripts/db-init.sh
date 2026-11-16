#!/usr/bin/env bash
# JeevanSetu MongoDB bootstrap.
# MongoDB collections and indexes are created lazily by the app on first use, so
# this script only verifies connectivity and optionally triggers the demo seed.
#
# Usage:
#   ./scripts/db-init.sh            # check MongoDB through the running app
#   ./scripts/db-init.sh --seed     # also load the demonstration dataset
set -euo pipefail

BASE_URL="${APP_URL:-http://127.0.0.1:3000}"

echo "[jeevansetu] checking MongoDB connectivity via ${BASE_URL}/api/health"
curl -fsS "${BASE_URL}/api/health"
echo

if [[ "${1:-}" == "--seed" ]]; then
  echo "[jeevansetu] logging in as admin to trigger the demo seed"
  COOKIE="$(mktemp)"
  curl -fsS -c "$COOKIE" -X POST "$BASE_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@jeevansetu.in","password":"admin123"}' > /dev/null
  curl -fsS -b "$COOKIE" -X POST "$BASE_URL/api/admin/seed" | head -c 400
  echo
  rm -f "$COOKIE"
fi

echo "[jeevansetu] database ready"
