# BLOCKED RECORD — GCP setup that would be needed (NOT a request)

Status: **BLOCKED — zero-input is absolute.** On 2026-11-12 at 19:46 MST
Eric said he will not set up anything: no GCP project, no billing,
no secrets, no setup login, no taps. This file is therefore NOT an
instruction to him. It is the record of the exact steps that WOULD be
needed, who would have to do them, and why they cannot happen without
him — so the prep is ready the day he changes his mind.

## The steps that would be needed (verbatim, for that day)

### 1. Open the Google Cloud console and sign in

URL: **https://console.cloud.google.com**

Sign in with his Google account — the account the project and billing
alerts would live under.

**Who:** Eric only. **Why it blocks:** creating a project and a
billing account are account-owner actions. No agent credential exists
that can do them for him (see "Why zero-input deployment is
impossible" in `cloud-run/README.md`).

### 2. Create the project

URL: **https://console.cloud.google.com/projectcreate**

- Project name: `jobboard-prod`
- Google generates a **Project ID** (e.g. `jobboard-prod-123456`).
  The ID — not the display name — is what deployment needs, and it
  only exists after this step.

**Who:** Eric only. **Why it blocks:** no GCP project exists, and
none can be created without an authenticated Google account.

### 3. Set up billing (card on file)

URL: **https://console.cloud.google.com/billing**

- Take the $300/90-day free trial if offered; otherwise create a
  billing account with a card on file.
- Link the billing account to the project (Billing → Link a project).

**Who:** Eric only. **Why it blocks:** a billing account + card is
his financial instrument. No agent can supply a card, and no GCP
usage (including free-tier usage) is possible without billing enabled
on the project.

### 4. Turn on the five APIs (one click)

URL (check the console top bar shows the new project first):

**https://console.cloud.google.com/flows/enableapi?apiid=run.googleapis.com,cloudbuild.googleapis.com,artifactregistry.googleapis.com,secretmanager.googleapis.com,cloudbilling.googleapis.com**

Click **Next**, then **Enable**.

**Who:** Eric, OR the deploy scripts (they enable the same APIs
automatically in pre-flight). This is the only step that is
automatable — but it still needs the project from step 2 to exist.

### 5. Hand over the Project ID

The deploy needs the exact Project ID from step 2 (and the billing
account ID, format `000000-000000-000000`, for the budget alert).

**Who:** Eric only — only he can see the ID Google generated.

## What would happen after that (no further input from him except two items)

1. **Push approval tap (him):** migration files pushed to GitHub —
   one tap, same as any push.
2. **Cloud Shell deploy (agent):** clone repo, run
   `./cloud-run/deploy-all.sh <PROJECT_ID>` — secrets, service,
   job, budget alert.
3. **One secret paste (him, ~30 seconds):** `MONGODB_URI` pasted
   once at a silent prompt during the deploy. It cannot be fetched
   for him: the Vercel connector's live tool list has no env-var read
   tool (only `create_project_env` / `edit_project_env`, both
   writes), so the dashboard copy-paste is the working path. The
   paste goes straight into Google Secret Manager — never shown,
   saved, or sent in chat.
4. **Canary + sweep (agent):** 14-employer canary on the new host,
   then full-roster sweep with auto-add, then a billing check.

## Approval taps / actions the unblocked path would need, in order

| # | What | Who | Avoidable? |
|---|------|-----|-----------|
| 1 | GCP project + billing creation (steps 1–3 above) | Eric | No — account-owner actions, no agent credential exists. |
| 2 | Push approval tap for the migration files | Eric | No — pushes need his tap. |
| 3 | Paste `MONGODB_URI` once at the silent prompt | Eric | No — no connector read tool exists for it. |
| 4 | Nothing else | — | SYNC_KEY comes from a file already on the agent VM; the budget alert needs only the billing account ID; Cloud Shell runs under his Google sign-in. |

Total from him on the unblocked path: ~10 min setup + one push tap +
one 30-second paste. Until then, deployment is not possible — see
`cloud-run/README.md` for the evidence.
