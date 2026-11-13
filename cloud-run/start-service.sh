#!/usr/bin/env bash
# Start the JobBoard service adapter against the LOCAL MongoDB.
# Reads SYNC_KEY from the key file at runtime (never prints it).
# MONGODB_URI defaults to the local mongod; PORT defaults to 8080.
# The service forces JOBBOARD_NO_RENDER=1 itself (rendering belongs
# to the finder runner, not the UI/API service).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export SYNC_KEY="$(cat /home/hatch/workspace/dealboard-ops/jobboard-sync-key.txt)"
export MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
export PORT="${PORT:-8080}"
exec node "$ROOT/cloud-run/server/dist-server/server.mjs"
