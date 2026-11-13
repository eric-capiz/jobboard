#!/usr/bin/env bash
# JobBoard — $1 billing-budget tripwire. Run on day one, before any sweep.
#
# Run in GCP Cloud Shell (gcloud authenticated as the user):
#   ./cloud-run/budget-alert.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>
#
# Creates ONE monthly budget of $1.00, scoped to this project only:
#   display name: jobboard-1-dollar-tripwire
#   thresholds:   50% ($0.50), 90% ($0.90), 100% ($1.00) of ACTUAL spend,
#                 plus 100% of FORECASTED spend (early warning)
#   notifications: email to billing admins/users (the default recipients
#                 — the Google account that owns the billing account).
#
# What a budget is and is NOT (read this before trusting it):
#   - It is a smoke detector, not a shut-off. Google sends an email when
#     a threshold is crossed; it does NOT stop Cloud Run, and it does
#     NOT cap spending. If an alert fires, a human has to act (scale
#     the service to 0, stop the job, check the billing page).
#   - Cost data can lag up to ~24h, so an alert always describes the
#     past. The $300/90-day trial credit covers small overages while
#     the alert is the tripwire — and the real protection is the
#     design itself (min-instances 0, max 2 instances, throttled
#     render rate, one sweep ≈ 30% of the Jobs free tier).
#   - The free tier is per BILLING ACCOUNT, shared across every project
#     on that account — not per project. If other projects share this
#     billing account, their usage counts against the same free tier
#     and the same $1 budget.
#
# Idempotent: if a budget with this display name already exists for the
# billing account, the script prints it and exits 0 without duplicating.
#
# Exit codes: 0 ok, 1 usage error, 2 pre-flight failure, 3 create failure.
set -euo pipefail

[[ $# -ge 2 ]] || { echo "Usage: budget-alert.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>" >&2; echo "  BILLING_ACCOUNT_ID looks like 000000-000000-000000 (Billing page)." >&2; exit 1; }
PROJECT_ID="$1"
BILLING_ACCOUNT_ID="$2"
DISPLAY_NAME="jobboard-1-dollar-tripwire"

# ---- pre-flight ------------------------------------------------------
echo "== pre-flight =="
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud is not installed. Run this in GCP Cloud Shell (https://console.cloud.google.com), not on the agent VM." >&2; exit 2; }
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
[[ -n "$ACCOUNT" ]] || { echo "ERROR: no active gcloud account. Run: gcloud auth login" >&2; exit 2; }
echo "authenticated as: $ACCOUNT"
gcloud billing accounts describe "$BILLING_ACCOUNT_ID" --format='value(name)' >/dev/null 2>&1 \
  || { echo "ERROR: billing account '$BILLING_ACCOUNT_ID' not found or not accessible to $ACCOUNT." >&2; exit 2; }
echo "billing account: $BILLING_ACCOUNT_ID"
LINKED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' 2>/dev/null || true)"
if [[ "$LINKED" != *"$BILLING_ACCOUNT_ID"* ]]; then
  echo "ERROR: project '$PROJECT_ID' is not linked to billing account '$BILLING_ACCOUNT_ID' (linked: ${LINKED:-none}).
  Link it first: Billing -> select the account -> Link a project, or:
    gcloud billing projects link $PROJECT_ID --billing-account=$BILLING_ACCOUNT_ID" >&2
  exit 2
fi
echo "project $PROJECT_ID is linked to this billing account"

# ---- idempotency -----------------------------------------------------
EXISTING="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT_ID" \
  --format='value(displayName)' 2>/dev/null | grep -Fx "$DISPLAY_NAME" || true)"
if [[ -n "$EXISTING" ]]; then
  echo "Budget '$DISPLAY_NAME' already exists on $BILLING_ACCOUNT_ID — nothing to do."
  gcloud billing budgets list --billing-account="$BILLING_ACCOUNT_ID" \
    --filter="displayName:$DISPLAY_NAME" --format='table(displayName,budgetFilter.projects,amount.specifiedAmount.units)' || true
  exit 0
fi

# ---- create ----------------------------------------------------------
echo "== creating \$1 budget '$DISPLAY_NAME' (project-scoped) =="
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT_ID" \
  --display-name="$DISPLAY_NAME" \
  --budget-amount=1 \
  --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted-spend \
  || { echo "ERROR: could not create the budget. Check that $ACCOUNT has Billing Account Administrator / Costs Manager (or project Owner/Editor for a project-scoped budget)." >&2; exit 3; }

echo
echo "== done =="
echo "Budget '$DISPLAY_NAME': \$1.00/month, project $PROJECT_ID only."
echo "Alerts (email to billing admins/users): 50% / 90% / 100% actual, 100% forecasted."
echo "Remember: alerts do NOT stop spending. If one fires, act the same day:"
echo "  gcloud run services update jobboard-service --min-instances 0 --max-instances 0 --region us-central1 --project $PROJECT_ID"
echo "  (and check Billing -> Cost table for what actually ran.)"
