#!/usr/bin/env bash
# Sync the live board state into the LOCAL MongoDB (one-way mirror).
# Runs hourly via cron. Fetches live /api/state (read-only GET); on success
# imports it into local dealboard.app_state. On any failure (Vercel paused,
# mongod down, network error) it keeps the local copy and exits 0.
# After Vercel pauses, the fetch fails and the local copy becomes the board.
# NOTE: this overwrites the local state doc. While the live board is the
# source of truth (sweep still adding), that is correct. Once Vercel is
# paused the sync stops by itself (fetch fails).
set -u
LOG="/home/hatch/workspace/jobboard/cloud-run/sync-state.log"
SNAP="/home/hatch/workspace/mongodb/state-snapshot.json"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# mongod must be up (import writes to local MongoDB)
if ! ss -ltn 2>/dev/null | grep -q "127.0.0.1:27017"; then
  echo "$(ts) sync-state: mongod not listening; skipping (watchdog will restart it)" >> "$LOG"
  exit 0
fi

KEY="$(cat /home/hatch/workspace/dealboard-ops/jobboard-sync-key.txt)"
if ! curl -s --compressed --retry 2 -H "x-sync-key: $KEY" \
    https://jobboard-eric-capizs-projects.vercel.app/api/state \
    -o "$SNAP.tmp" -w "%{http_code}" | grep -q "200"; then
  echo "$(ts) sync-state: live fetch failed; keeping local copy" >> "$LOG"
  rm -f "$SNAP.tmp"
  exit 0
fi
mv "$SNAP.tmp" "$SNAP"
if node /home/hatch/workspace/jobboard/cloud-run/import-state.mjs "$SNAP" >> "$LOG" 2>&1; then
  echo "$(ts) sync-state: imported live state into local MongoDB" >> "$LOG"
else
  echo "$(ts) sync-state: import FAILED (local copy untouched)" >> "$LOG"
fi
