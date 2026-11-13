#!/usr/bin/env bash
# JobBoard Cloud Run migration — deploy everything, in order.
#
# BLOCKED (2026-11-12): zero-input is absolute — Eric will not create
# a GCP project/billing, reply with a Project ID, or paste secrets.
# This script cannot run until that changes; see cloud-run/README.md
# ("Why zero-input deployment is impossible") and ERIC-SETUP.md.
# It is kept ready for the day it unblocks. Do not run it expecting
# a zero-input deploy — the pre-flight will fail on the missing
# project, and set-env.sh will still need the MONGODB_URI paste.
#
# Run in GCP Cloud Shell (gcloud authenticated as the user), from the
# cloned repo root:
#   ./cloud-run/deploy-all.sh <PROJECT_ID> [BILLING_ACCOUNT_ID]
#
# Order (fails fast — a failed step stops everything):
#   1. set-env.sh       — secrets into Secret Manager (see its header
#                         for how MONGODB_URI / SYNC_KEY get in; if
#                         stdin is a terminal it will prompt once for a
#                         silent paste of MONGODB_URI).
#   2. deploy-service.sh — UI/API service (Cloud Build builds in GCP).
#   3. deploy-job.sh    — finder-runner job (fails fast if piece (b)
#                         hasn't landed yet — see its error message).
#   4. budget-alert.sh  — $1 billing-budget tripwire. Runs ONLY if a
#                         BILLING_ACCOUNT_ID is given; otherwise it is
#                         skipped with a loud warning — run it separately
#                         the moment you have the billing account ID:
#                           ./cloud-run/budget-alert.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>
#
# PROJECT_ID is the ID Google generated for the project Eric created
# (e.g. jobboard-prod-<digits> — the ID, not the display name).
# BILLING_ACCOUNT_ID looks like 000000-000000-000000 (Billing page).
#
# Exit codes: 0 ok (budget step skipped only if no billing account ID
# was given — read the output), 1 usage error, else the failing step's.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "Usage: deploy-all.sh <PROJECT_ID> [BILLING_ACCOUNT_ID]" >&2; exit 1; }
PROJECT_ID="$1"
BILLING_ACCOUNT_ID="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "================================================================"
echo " JobBoard Cloud Run deploy — project: $PROJECT_ID"
echo "================================================================"

echo
echo "--- step 1/4: secrets (set-env.sh) ---"
"$SCRIPT_DIR/set-env.sh" "$PROJECT_ID"

echo
echo "--- step 2/4: UI/API service (deploy-service.sh) ---"
"$SCRIPT_DIR/deploy-service.sh" "$PROJECT_ID"

echo
echo "--- step 3/4: finder-runner job (deploy-job.sh) ---"
"$SCRIPT_DIR/deploy-job.sh" "$PROJECT_ID"

echo
echo "--- step 4/4: \$1 budget alert (budget-alert.sh) ---"
if [[ -n "$BILLING_ACCOUNT_ID" ]]; then
  "$SCRIPT_DIR/budget-alert.sh" "$PROJECT_ID" "$BILLING_ACCOUNT_ID"
else
  cat <<'EOF'
WARNING: no BILLING_ACCOUNT_ID given — budget alert NOT created.
Run it as soon as you have the billing account ID (Billing page):
  ./cloud-run/budget-alert.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>
Do not run sweeps until the $1 tripwire exists.
EOF
fi

echo
echo "================================================================"
echo " Deploy complete for project $PROJECT_ID."
echo " Service URL was printed by step 2 — open it and check the board"
echo " loads, then run the 14-employer canary (cloud-run/README.md)"
echo " before any full-roster sweep."
echo "================================================================"
