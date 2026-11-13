#!/usr/bin/env bash
# JobBoard UI/API service — deploy to Cloud Run from source.
#
# Run in GCP Cloud Shell (gcloud authenticated as the user), from the
# cloned repo root:
#   ./cloud-run/deploy-service.sh <PROJECT_ID> [REGION]
#
# What it does:
#   1. Pre-flight: gcloud auth, project exists, required APIs enabled.
#   2. Checks the three secrets exist (run set-env.sh first if not).
#   3. Fetches VITE_SYNC_KEY from Secret Manager and passes it as a
#      BUILD arg — the Dockerfile bakes it into the browser bundle, so
#      the build needs the real value. The value lives only in shell
#      memory for the duration of this one command: it is never
#      printed, never written to a file, and never passed as a plain
#      --set-env-vars value. (Trade-off, stated plainly: it does appear
#      in the gcloud process's argv while the build runs. Cloud Shell
#      is single-user; if that ever worries you, rotate the key with
#      set-env.sh --force and redeploy.)
#   4. `gcloud run deploy jobboard-service --source . --dockerfile
#      cloud-run/Dockerfile.service` — Cloud Build builds the image in
#      GCP (no local Docker needed, ever). Flags mirror service.yaml
#      exactly: cpu 1, memory 512Mi, min-instances 0, max-instances 2,
#      concurrency 80, timeout 300s, port 8080.
#   5. Prints the resulting service URL.
#
# Runtime secrets are attached with --set-secrets (references only):
#   MONGODB_URI=mongodb-uri:latest, SYNC_KEY=sync-key:latest,
#   VITE_SYNC_KEY=vite-sync-key:latest.
#
# Service name is `jobboard-service` per the migration spec.
# Exit codes: 0 ok, 1 usage error, 2 pre-flight failure, 3 deploy failure.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "Usage: deploy-service.sh <PROJECT_ID> [REGION]  (default region us-central1)" >&2; exit 1; }
PROJECT_ID="$1"
REGION="${2:-us-central1}"
SERVICE="jobboard-service"

# Resolve repo root from this script's location (works from anywhere).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
echo "repo root: $ROOT"

# ---- pre-flight ------------------------------------------------------
echo "== pre-flight =="
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud is not installed. Run this in GCP Cloud Shell (https://console.cloud.google.com), not on the agent VM." >&2; exit 2; }
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
[[ -n "$ACCOUNT" ]] || { echo "ERROR: no active gcloud account. Run: gcloud auth login" >&2; exit 2; }
echo "authenticated as: $ACCOUNT"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 \
  || { echo "ERROR: project '$PROJECT_ID' not found or not accessible to $ACCOUNT." >&2; exit 2; }
echo "project: $PROJECT_ID  region: $REGION"
echo "enabling APIs (idempotent)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  --project="$PROJECT_ID" --quiet \
  || { echo "ERROR: could not enable required APIs on $PROJECT_ID." >&2; exit 2; }
echo "APIs enabled: run, cloudbuild, artifactregistry, secretmanager"

[[ -f cloud-run/Dockerfile.service ]] \
  || { echo "ERROR: cloud-run/Dockerfile.service not found in $ROOT — piece (a) of the migration is missing. Clone the full repo first." >&2; exit 2; }
[[ -f cloud-run/server/server.mjs ]] \
  || { echo "ERROR: cloud-run/server/server.mjs not found — piece (a) is incomplete." >&2; exit 2; }

# Secrets must exist before the service can reference them.
for s in mongodb-uri sync-key vite-sync-key; do
  gcloud secrets describe "$s" --project="$PROJECT_ID" >/dev/null 2>&1 \
    || { echo "ERROR: secret '$s' does not exist in $PROJECT_ID. Run ./cloud-run/set-env.sh $PROJECT_ID first." >&2; exit 2; }
  gcloud secrets versions list "$s" --project="$PROJECT_ID" --format='value(name)' 2>/dev/null | grep -q . \
    || { echo "ERROR: secret '$s' has no versions. Run ./cloud-run/set-env.sh $PROJECT_ID first." >&2; exit 2; }
done
echo "secrets present: mongodb-uri, sync-key, vite-sync-key"

# ---- deploy ----------------------------------------------------------
echo "== deploying service '$SERVICE' (Cloud Build builds the image in GCP) =="
# VITE_SYNC_KEY is a build arg: fetched from Secret Manager into shell
# memory only, for this one command. Never echoed, never written down.
VITE_SYNC_KEY_VALUE="$(gcloud secrets versions access latest --secret=vite-sync-key --project="$PROJECT_ID")" \
  || { echo "ERROR: could not read secret 'vite-sync-key'." >&2; exit 3; }
gcloud run deploy "$SERVICE" \
  --source . \
  --dockerfile cloud-run/Dockerfile.service \
  --build-arg "VITE_SYNC_KEY=$VITE_SYNC_KEY_VALUE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 2 \
  --concurrency 80 \
  --timeout 300 \
  --port 8080 \
  --allow-unauthenticated \
  --set-secrets "MONGODB_URI=mongodb-uri:latest,SYNC_KEY=sync-key:latest,VITE_SYNC_KEY=vite-sync-key:latest" \
  || { echo "ERROR: gcloud run deploy failed." >&2; exit 3; }
unset VITE_SYNC_KEY_VALUE

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --project "$PROJECT_ID" --format='value(status.url)')"
echo
echo "== deployed =="
echo "Service: $SERVICE"
echo "URL: $URL"
echo "Config: cpu 1, memory 512Mi, min 0 / max 2 instances, concurrency 80, timeout 300s, port 8080"
echo "Next: ./cloud-run/deploy-job.sh $PROJECT_ID"
