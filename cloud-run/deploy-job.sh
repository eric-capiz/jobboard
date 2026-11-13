#!/usr/bin/env bash
# JobBoard finder runner — deploy/update the Cloud Run Job from job.yaml.
#
# Run in GCP Cloud Shell (gcloud authenticated as the user), from the
# cloned repo root:
#   ./cloud-run/deploy-job.sh <PROJECT_ID> [REGION]
#
# What it does:
#   1. Pre-flight: gcloud auth, project exists, required APIs enabled.
#   2. Checks cloud-run/runner/job.yaml exists (migration piece (b):
#      the finder-runner image WITH Chromium + sweep driver). If it is
#      missing it FAILS FAST with a clear message — it never deploys a
#      half-migration.
#   3. Builds the runner image with Cloud Build
#      (`gcloud builds submit`, tag gcr.io/<PROJECT>/jobboard-runner:latest)
#      — the image the job references does not exist until this runs.
#      Skip with SKIP_BUILD=1 if the image is already built and you
#      only want to update the job spec.
#   4. Substitutes the PROJECT_ID placeholder in a TEMP COPY of
#      job.yaml (the template in the repo is never modified) and runs
#      `gcloud run jobs replace` — create-or-update in one command.
#   5. Prints the job name and the exact command to run a sweep.
#
# The job itself is NOT executed by this script. Run it on demand with:
#   gcloud run jobs execute <JOB_NAME> --region <REGION> --project <PROJECT_ID>
# (or on a schedule later, once the canary proves the new host.)
#
# Exit codes: 0 ok, 1 usage error, 2 pre-flight / missing-piece failure,
# 3 deploy failure.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "Usage: deploy-job.sh <PROJECT_ID> [REGION]  (default region us-central1)" >&2; exit 1; }
PROJECT_ID="$1"
REGION="${2:-us-central1}"

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
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  --project="$PROJECT_ID" --quiet \
  || { echo "ERROR: could not enable required APIs on $PROJECT_ID." >&2; exit 2; }

# ---- piece (b) must exist --------------------------------------------
[[ -f cloud-run/runner/job.yaml ]] \
  || { echo "ERROR: cloud-run/runner/job.yaml not found — migration piece (b)
  (finder-runner image + job.yaml) has not landed in this repo yet.
  Deploy the service first (deploy-service.sh), then re-run this script
  once piece (b) is pushed. Nothing was deployed." >&2; exit 2; }
[[ -f cloud-run/runner/Dockerfile.runner ]] \
  || { echo "ERROR: cloud-run/runner/Dockerfile.runner not found — piece (b) is incomplete." >&2; exit 2; }

# Job name: first `name:` under metadata in job.yaml (best effort).
JOB_NAME="$(sed -n '/^metadata:/,/^[^ ]/p' cloud-run/runner/job.yaml | sed -n 's/^  name: *//p' | head -n 1)"
[[ -n "$JOB_NAME" ]] || JOB_NAME="jobboard-finder"
echo "job: $JOB_NAME"

# ---- build the runner image (Cloud Build builds in GCP) ------------
# The job references gcr.io/<PROJECT>/jobboard-runner:latest; that
# image does not exist until this runs. No local Docker is ever
# needed. Skip only when the image is already built and the job spec
# alone changed: SKIP_BUILD=1 ./cloud-run/deploy-job.sh <PROJECT>.
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "== building runner image gcr.io/$PROJECT_ID/jobboard-runner:latest (Cloud Build) =="
  gcloud builds submit --tag "gcr.io/$PROJECT_ID/jobboard-runner:latest" \
    --file cloud-run/runner/Dockerfile.runner . \
    --project "$PROJECT_ID" --quiet \
    || { echo "ERROR: Cloud Build failed for the runner image." >&2; exit 3; }
else
  echo "SKIP_BUILD=1: skipping image build (using existing gcr.io/$PROJECT_ID/jobboard-runner:latest)"
fi

# ---- deploy ----------------------------------------------------------
echo "== deploying job '$JOB_NAME' from cloud-run/runner/job.yaml =="
TMP_YAML="$(mktemp /tmp/jobboard-job-XXXXXX.yaml)"
trap 'rm -f "$TMP_YAML"' EXIT
# Substitute the PROJECT_ID placeholder in the temp copy only.
sed "s/PROJECT_ID/$PROJECT_ID/g" cloud-run/runner/job.yaml > "$TMP_YAML"
grep -q "$PROJECT_ID" "$TMP_YAML" \
  || echo "NOTE: no PROJECT_ID placeholder found in job.yaml — using it as-is."
gcloud run jobs replace "$TMP_YAML" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  || { echo "ERROR: gcloud run jobs replace failed." >&2; exit 3; }

gcloud run jobs describe "$JOB_NAME" --region "$REGION" \
  --project "$PROJECT_ID" --format='value(metadata.name)' >/dev/null \
  || { echo "ERROR: job '$JOB_NAME' not found after replace." >&2; exit 3; }
echo
echo "== deployed =="
echo "Job: $JOB_NAME"
echo "It is NOT running yet. Run a sweep on demand with:"
echo "  gcloud run jobs execute $JOB_NAME --region $REGION --project $PROJECT_ID"
echo "Do the 14-employer canary first (see cloud-run/README.md) before any full-roster sweep."
