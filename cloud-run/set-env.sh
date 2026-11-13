#!/usr/bin/env bash
# JobBoard UI/API service — create/update the three GCP secrets.
#
# Run in GCP Cloud Shell (gcloud authenticated as the user), from the
# cloned repo root:
#   ./cloud-run/set-env.sh <PROJECT_ID> [--force] [--sync-key-file PATH]
#                                              [--mongodb-uri-stdin]
#                                              [--mongodb-uri-file PATH]
#
# Secrets created (Secret Manager, one per env var; values are NEVER
# printed, echoed, logged, or written to any file by this script):
#   mongodb-uri    <- MONGODB_URI  (MongoDB Atlas connection string)
#   sync-key       <- SYNC_KEY     (server-side sync key)
#   vite-sync-key  <- VITE_SYNC_KEY (== SYNC_KEY; baked into the browser
#                      bundle at build time by deploy-service.sh)
#
# How each value gets in (no value ever travels through chat):
#   MONGODB_URI — one of:
#     (a) piped stdin:  <producer> | ./cloud-run/set-env.sh <PROJECT_ID> --mongodb-uri-stdin
#         The intended producer is the agent-side Vercel connector read
#         (decrypt). GAP, verified 2026-11-12: the live Vercel MCP tool
#         list has NO get_project_env / env-read tool — only
#         create_project_env and edit_project_env (writes). Until a read
#         tool is advertised, use (b) or (c) instead; do NOT invent a
#         connector call. When a read tool exists, it plugs into (a).
#     (b) interactive silent paste (default when stdin is a terminal):
#         the script prompts once and reads with `read -rs` (input
#         hidden, nothing echoed). Copy MONGODB_URI from the Vercel
#         dashboard: vercel.com -> project `jobboard` -> Settings ->
#         Environment Variables -> MONGODB_URI -> reveal/copy, then
#         paste it at the prompt. It goes straight into Secret Manager.
#     (c) file: --mongodb-uri-file PATH  (a file you placed in Cloud
#         Shell yourself; --data-file reads it directly, no shell var).
#   SYNC_KEY — read from a local file at deploy time, never printed:
#         --sync-key-file PATH, else $SYNC_KEY_FILE, else
#         ~/workspace/dealboard-ops/jobboard-sync-key.txt, else
#         ~/jobboard-sync-key.txt. In Cloud Shell, upload the file from
#         the agent VM first (Cloud Shell's upload button / drag-drop
#         into ~ — never commit it to the repo). The file is passed to
#         gcloud with --data-file= so its contents never enter a shell
#         variable. VITE_SYNC_KEY is created from the same file.
#
# Idempotent: a secret that already has a version is left alone unless
# --force is given (rotation = a new version; old versions stay until
# you destroy them). Also grants the project's Compute Engine default
# service account roles/secretmanager.secretAccessor on each secret —
# that is the identity Cloud Run runs as, and without the grant the
# service fails to start (secret access denied).
#
# Exit codes: 0 ok, 1 usage error, 2 pre-flight failure, 3 secret failure.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: set-env.sh <PROJECT_ID> [--force] [--sync-key-file PATH]
                              [--mongodb-uri-stdin] [--mongodb-uri-file PATH]
  PROJECT_ID         GCP project ID (e.g. jobboard-prod — the ID Google
                     generated, not the display name).
  --force            Add a new version even if the secret already has one.
  --sync-key-file    File holding SYNC_KEY (default: see header).
  --mongodb-uri-stdin  Read MONGODB_URI from stdin (piped, or silent
                     paste when stdin is a terminal).
  --mongodb-uri-file   File holding MONGODB_URI.
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
PROJECT_ID="$1"; shift
FORCE=0
SYNC_KEY_FILE="${SYNC_KEY_FILE:-}"
MONGO_STDIN=0
MONGO_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --sync-key-file) SYNC_KEY_FILE="${2:-}"; shift ;;
    --mongodb-uri-stdin) MONGO_STDIN=1 ;;
    --mongodb-uri-file) MONGO_FILE="${2:-}"; shift ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage ;;
  esac
  shift
done
[[ -n "$SYNC_KEY_FILE" ]] || SYNC_KEY_FILE="$HOME/workspace/dealboard-ops/jobboard-sync-key.txt"
if [[ ! -f "$SYNC_KEY_FILE" && -f "$HOME/jobboard-sync-key.txt" ]]; then
  SYNC_KEY_FILE="$HOME/jobboard-sync-key.txt"
fi

# ---- pre-flight ------------------------------------------------------
echo "== pre-flight =="
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud is not installed. Run this in GCP Cloud Shell (https://console.cloud.google.com), not on the agent VM." >&2; exit 2; }
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
[[ -n "$ACCOUNT" ]] || { echo "ERROR: no active gcloud account. Run: gcloud auth login" >&2; exit 2; }
echo "authenticated as: $ACCOUNT"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 \
  || { echo "ERROR: project '$PROJECT_ID' not found or not accessible to $ACCOUNT. Check the ID Eric replied with." >&2; exit 2; }
echo "project: $PROJECT_ID"
gcloud services enable secretmanager.googleapis.com run.googleapis.com \
  --project="$PROJECT_ID" --quiet >/dev/null \
  || { echo "ERROR: could not enable secretmanager/run APIs on $PROJECT_ID." >&2; exit 2; }
echo "APIs enabled: secretmanager.googleapis.com, run.googleapis.com"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "runtime service account: $RUNTIME_SA"

# ---- helpers ---------------------------------------------------------
ensure_secret() { # ensure_secret <name>
  local name="$1"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "secret '$name' already exists"
  else
    gcloud secrets create "$name" --project="$PROJECT_ID" \
      --labels=app=jobboard --replication-policy=automatic --quiet >/dev/null \
      || { echo "ERROR: could not create secret '$name'." >&2; exit 3; }
    echo "created secret '$name'"
  fi
  # Runtime identity must be able to read the secret, or Cloud Run
  # fails at startup with a secret-access error.
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role="roles/secretmanager.secretAccessor" --quiet >/dev/null \
    || { echo "ERROR: could not grant secretAccessor on '$name' to $RUNTIME_SA." >&2; exit 3; }
}

has_version() { # has_version <name> -> 0 if >=1 version exists
  gcloud secrets versions list "$1" --project="$PROJECT_ID" \
    --format='value(name)' 2>/dev/null | grep -q .
}

add_version_from_file() { # add_version_from_file <secret> <file>
  local name="$1" file="$2"
  if [[ "$FORCE" -eq 0 ]] && has_version "$name"; then
    echo "secret '$name' already has a version; skipping (use --force to rotate)"
    return 0
  fi
  # --data-file reads the file directly: the value never enters a shell
  # variable, never prints, never lands in history.
  local ver
  ver="$(gcloud secrets versions add "$name" --project="$PROJECT_ID" \
    --data-file="$file" --format='value(name)')" \
    || { echo "ERROR: could not add a version to secret '$name'." >&2; exit 3; }
  echo "secret '$name': added version $ver"
}

# ---- SYNC_KEY (+ VITE_SYNC_KEY, same value) --------------------------
[[ -f "$SYNC_KEY_FILE" ]] || { echo "ERROR: SYNC_KEY file not found: $SYNC_KEY_FILE
  Upload ~/workspace/dealboard-ops/jobboard-sync-key.txt from the agent VM
  into Cloud Shell home (upload button), or pass --sync-key-file PATH.
  The file is NEVER committed to the repo." >&2; exit 2; }
ensure_secret sync-key
ensure_secret vite-sync-key
add_version_from_file sync-key "$SYNC_KEY_FILE"
add_version_from_file vite-sync-key "$SYNC_KEY_FILE"
echo "(SYNC_KEY and VITE_SYNC_KEY set from file; values not shown)"

# ---- MONGODB_URI -----------------------------------------------------
ensure_secret mongodb-uri
if [[ "$FORCE" -eq 0 ]] && has_version mongodb-uri; then
  echo "secret 'mongodb-uri' already has a version; skipping (use --force to rotate)"
elif [[ -n "$MONGO_FILE" ]]; then
  [[ -f "$MONGO_FILE" ]] || { echo "ERROR: --mongodb-uri-file not found: $MONGO_FILE" >&2; exit 2; }
  add_version_from_file mongodb-uri "$MONGO_FILE"
  echo "(MONGODB_URI set from file; value not shown)"
elif [[ "$MONGO_STDIN" -eq 1 || ! -t 0 ]]; then
  if [[ -t 0 ]]; then
    # Interactive silent paste: input hidden, nothing echoed.
    printf 'Paste MONGODB_URI (input hidden, press Enter when done): ' >&2
    IFS= read -rs MONGO_VALUE || true
    printf '\n' >&2
    [[ -n "${MONGO_VALUE:-}" ]] || { echo "ERROR: empty input; MONGODB_URI not set." >&2; exit 3; }
    printf '%s' "$MONGO_VALUE" | gcloud secrets versions add mongodb-uri \
      --project="$PROJECT_ID" --data-file=- --format='value(name)' >/dev/null \
      || { echo "ERROR: could not add a version to secret 'mongodb-uri'." >&2; exit 3; }
    unset MONGO_VALUE
    echo "secret 'mongodb-uri': added a version (value not shown)"
  else
    # Piped stdin flows straight into gcloud; this script never holds
    # the value in a variable and never prints it.
    gcloud secrets versions add mongodb-uri --project="$PROJECT_ID" \
      --data-file=- --format='value(name)' >/dev/null \
      || { echo "ERROR: could not add a version to secret 'mongodb-uri'." >&2; exit 3; }
    echo "secret 'mongodb-uri': added a version from stdin (value not shown)"
  fi
else
  # Stdin is a terminal and no source was given: silent-paste prompt.
  printf 'Paste MONGODB_URI (input hidden, press Enter when done): ' >&2
  IFS= read -rs MONGO_VALUE || true
  printf '\n' >&2
  [[ -n "${MONGO_VALUE:-}" ]] || { echo "ERROR: empty input; MONGODB_URI not set." >&2; exit 3; }
  printf '%s' "$MONGO_VALUE" | gcloud secrets versions add mongodb-uri \
    --project="$PROJECT_ID" --data-file=- --format='value(name)' >/dev/null \
    || { echo "ERROR: could not add a version to secret 'mongodb-uri'." >&2; exit 3; }
  unset MONGO_VALUE
  echo "secret 'mongodb-uri': added a version (value not shown)"
fi

echo
echo "== done =="
echo "Secrets in project $PROJECT_ID (names only, never values):"
gcloud secrets list --project="$PROJECT_ID" --filter='labels.app=jobboard' \
  --format='table(name,createTime)' 2>/dev/null || true
echo "Next: ./cloud-run/deploy-service.sh $PROJECT_ID"
