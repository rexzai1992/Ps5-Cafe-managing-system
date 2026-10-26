#!/usr/bin/env bash
# Runs PS5 Cafe for real on this computer: live mode (screen-only TVs, real time, no simulation), with the dashboard,
# TV screens and booking pages all on one address. The first run creates .env.live with a new staff password.
# Stop with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.live
if [ ! -f "$ENV_FILE" ]; then
  (
    umask 077
    {
      echo "# PS5 Cafe live settings. Never commit or share this file: the token is the staff password."
      echo "PS5_CAFE_API_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
      echo "PORT=8080"
      echo "STATION_COUNT=10"
    } > "$ENV_FILE"
  )
  echo "Created $ENV_FILE with a new staff password."
fi
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a
export NODE_ENV=production SIMULATION_MODE=false HOST="${HOST:-0.0.0.0}"

npm run build
echo "Staff dashboard: http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):${PORT}/ (staff password: PS5_CAFE_API_TOKEN in $ENV_FILE)"
# caffeinate keeps the Mac awake (on mains power) while the server runs.
exec caffeinate -is node apps/server/dist/index.js
