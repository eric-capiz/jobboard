# JobBoard — Cloud Run migration (master doc)

## Status (2026-11-12, ~19:48 MST)

**Migration prep: COMPLETE. Deployment: BLOCKED.**

Eric (19:46 MST): "Im not setting up anything. Its all on u." —
zero-input is absolute. He will not create a GCP project, turn on
billing, add secrets, or tap any setup login. Nothing below can be
deployed until he changes his mind. The prep is finished and ready
for that day; the blockers and the evidence are in the next section.
Do not ask him again — this doc is the record.

Vercel context: the free team hit 101% Fluid Active CPU and pauses
~16:18 MST Nov 13, 2026. That pause is not something this migration
can dodge without Eric either (see "Why zero-input deployment is
impossible").

## Why zero-input deployment is impossible (evidence, checked 2026-11-12)

There is **no deployment path that needs zero input from Eric using
only what exists on this VM**. Each candidate fails on a concrete fact:

| What a zero-input deploy would need | What actually exists | Verdict |
|-------------------------------------|----------------------|---------|
| A way to reach GCP (gcloud CLI, or an API client with credentials) | No `gcloud`, `docker`, `podman`, `gsutil`, or `bq` on this VM. No `~/.config/gcloud`. No Google/GCP env vars set. No service-account or GCP key file anywhere under home/workspace (searched by name, 3 levels deep). | **Missing.** Installing gcloud would not help: `gcloud auth login` needs his browser sign-in, and there is no service account to authenticate with. |
| A GCP connector in Muse | None exists. Connector search for "Google Cloud Platform / gcloud / Cloud Run" returns only Google Workspace app connectors (Calendar, Docs, Drive, Sheets, …) and Vercel. None can create GCP projects, manage billing, or deploy Cloud Run — and their OAuth scopes are for those apps, not Cloud Platform. | **Missing.** |
| A GCP project + billing account to deploy into | None exists. A project and a billing account (card on file) can only be created by the Google account owner. | **Missing, Eric-only.** |
| `MONGODB_URI` without Eric | The Vercel connector's live tool list (checked 2026-11-12 via `list-tools`) has **no env-var read tool** — only `create_project_env` and `edit_project_env` (both writes). There is no `.env` file in the repo, and per standing memory the VM has no `MONGODB_URI`. | **Missing, Eric-only** (dashboard copy-paste, ~30 s, see `ERIC-SETUP.md`). |
| `SYNC_KEY` without Eric | Present: `~/workspace/dealboard-ops/jobboard-sync-key.txt` exists on this VM (verified by filename/size only — value never read or printed). | **Available.** The one input that is NOT blocked. |
| A way to pay if anything goes over free tier | No billing account, no card. The $300/90-day trial credit only exists after he creates the account. | **Missing, Eric-only.** |

What would unblock it, in one line: Eric does the ~10-minute setup
in `ERIC-SETUP.md` (project + billing + APIs) and replies with the
Project ID, plus one push tap and one 30-second `MONGODB_URI` paste
at deploy time. Nothing else is needed from him — see that file's
tap table.

## Architecture (two images, what runs where)

```
Repo root (eric-capiz/jobboard)
└── cloud-run/
    ├── server/                  piece (a) — UI/API service image, NO Chromium
    │   ├── server.mjs           Node entry: serves dist/ + /api/*, forces
    │   │                        JOBBOARD_NO_RENDER=1 (service never renders)
    │   └── build.sh             bundles server.mjs + api/ -> dist-server/
    ├── Dockerfile.service       piece (a) — build context = repo root.
    │                            Stage 1: vite build (+ VITE_SYNC_KEY build
    │                            arg, baked into the browser bundle).
    │                            Stage 2: node:22-slim, prod deps only.
    ├── runner/                  piece (b) — finder-runner image, WITH
    │                            Chromium + sweep driver + job.yaml
    │                            *** NOT YET LANDED (checked 19:47 MST:
    │                            cloud-run/runner/ does not exist) ***
    │                            deploy-job.sh fails fast until it does.
    ├── service.yaml             this piece — Service spec (see below)
    ├── deploy-service.sh        deploy the service from source
    ├── deploy-job.sh            deploy/update the job from job.yaml
    ├── deploy-all.sh            secrets -> service -> job -> budget alert
    ├── set-env.sh               secrets into Secret Manager (no values printed)
    ├── budget-alert.sh          $1 billing-budget tripwire
    ├── budget.yaml              declarative record of that budget
    ├── ERIC-SETUP.md            BLOCKED RECORD (not a request — see above)
    └── README.md                this file
```

- **UI/API service** (`jobboard-service`): 1 vCPU, 512Mi, min 0 / max 2
  instances, concurrency 80, timeout 300s, port 8080. Serves the SPA
  and the `/api/*` handlers. No Chromium, no rendering. Secrets
  (`MONGODB_URI`, `SYNC_KEY`, `VITE_SYNC_KEY`) as Secret Manager
  references; `VITE_SYNC_KEY` is additionally a build arg because the
  browser bundle needs it at build time.
- **Finder runner** (`jobboard-finder` job, piece (b)): Chromium +
  sweep driver. Runs on demand (`gcloud run jobs execute ...`), not
  on a schedule, until the canary proves the new host.
- **Data**: unchanged — MongoDB Atlas db `dealboard`. No board writes
  happen in this migration; the service reads the same state the
  Vercel app reads today.
- **Region**: `us-central1` everywhere (Tier 1 pricing — the free-tier
  numbers below are quoted for it).

## Deploy order (for the day it unblocks)

In GCP Cloud Shell, from the cloned repo root:

```bash
./cloud-run/deploy-all.sh <PROJECT_ID> [BILLING_ACCOUNT_ID]
```

It runs, failing fast at any step:

1. **`set-env.sh <PROJECT_ID>`** — creates secrets `mongodb-uri`,
   `sync-key`, `vite-sync-key` in Secret Manager; grants the
   project's Compute Engine default service account
   `roles/secretmanager.secretAccessor` on each (otherwise Cloud Run
   fails at startup). `SYNC_KEY` is read from
   `~/workspace/dealboard-ops/jobboard-sync-key.txt` (uploaded into
   Cloud Shell first — never committed). `MONGODB_URI` arrives by
   piped stdin, a file, or a one-time silent paste (`read -rs`) —
   never printed, echoed, or written to disk by the script.
2. **`deploy-service.sh <PROJECT_ID>`** — `gcloud run deploy
   jobboard-service --source . --dockerfile
   cloud-run/Dockerfile.service`, Cloud Build builds the image in GCP
   (no local Docker ever). Fetches `VITE_SYNC_KEY` from Secret
   Manager into shell memory for the one `--build-arg`. Prints the
   service URL.
3. **`deploy-job.sh <PROJECT_ID>`** — substitutes `PROJECT_ID` into
   a temp copy of `cloud-run/runner/job.yaml` and runs `gcloud run
   jobs replace` (create-or-update). Does NOT execute the job.
4. **`budget-alert.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>`** — the $1
   tripwire (skipped with a loud warning if no billing account ID was
   given; run it separately the moment the ID exists).

Each script also runs standalone, has its own pre-flight (gcloud
auth, project exists, APIs enabled, secrets present where needed),
and documents its own inputs in its header. `service.yaml` is the
declarative record of the service config; the deploy flags mirror it
exactly. (Name note: piece (a)'s Dockerfile header comment shows the
example service name `jobboard`; the migration spec — and these
scripts — use `jobboard-service`. One-word change in both files if
the coordinator renames it.)

## Free-tier math (verified, not assumed)

Sources: Google's official pricing page,
https://cloud.google.com/run/pricing (fetched and read 2026-11-13
02:44 UTC), cross-checked against
https://exodus.elim.io/blog/the-cloud-run-free-tier-explained,
https://stacksfree.com/blog/google-cloud-run-free-tier-guide-2026/,
https://dev.to/elimio/what-cloud-run-costs-with-worked-examples-378i
(all read Oct 2026, all agree with Google's page).

**Verified free tier, us-central1, per billing account per month
(shared across ALL projects on that account — not per project):**

| | Free / month | Overage rate |
|---|---|---|
| Cloud Run **Jobs** | 240,000 vCPU-s + 450,000 GiB-s | CPU $0.000018/vCPU-s, memory $0.000002/GiB-s |
| Cloud Run **Services, request-based** | 180,000 vCPU-s + 360,000 GiB-s + 2,000,000 requests | CPU $0.000024/vCPU-s (active), memory $0.0000025/GiB-s, $0.40 / 1M requests |

**Correction to the rebuild's numbers:** the rebuild quoted overage
as "$0.000024/vCPU-s". That is the *request-based service* rate. The
*Jobs* rate — the one a sweep pays — is cheaper: **$0.000018/vCPU-s**.
The free-tier allowances themselves (Jobs 240k/450k; services
180k/360k/2M) were confirmed exactly as the rebuild stated.

**The math:**

- One full sweep ≈ 70,000 vCPU-s (rebuild's estimate — **not yet
  confirmed by a real run on Cloud Run**; confirm from the first
  sweep's billing data). 70,000 / 240,000 ≈ **29% of the Jobs CPU
  free tier**. At 512Mi, memory is ≈ 35,000 GiB-s ≈ **8% of the Jobs
  memory tier**. CPU is the binding constraint, with ~3.4x headroom —
  about three full sweeps a month would fit before the CPU tier ends.
- Worst case if the free tier were already exhausted: one full sweep
  would cost 70,000 × $0.000018 + 35,000 × $0.000002 ≈ **$1.33**.
  That is the maximum plausible overage for a single sweep, not a
  prediction — the prediction is $0.
- UI service at min-instances 0: Eric-only traffic, a handful of
  requests a day. Even 10,000 requests/month at ~200 ms average is
  2,000 vCPU-s ≈ **~1% of the service CPU tier**, and a tiny fraction
  of the 2M-request allowance. It sits well inside its free tier.
- **Honest statement: Cloud Run at $0 is "very likely with large
  margin," NOT guaranteed.** The free tier is a monthly spending
  discount at Tier 1 prices; Google can change limits with notice;
  other small lines exist (Cloud Build build minutes per deploy,
  Artifact Registry image storage — neither quantified to a number
  here; check them on the first billing review). Mitigations, in
  order: min-instances 0 + max 2 instances (no idle burn), throttled
  render rate, the $1 budget alert (emails at $0.50 / $0.90 / $1.00
  actual + $1.00 forecasted — it alerts, it does NOT stop spending),
  and the $300/90-day trial credit absorbing any small overage while
  the alert is the tripwire.

## Remaining steps (in order)

1. **[BLOCKED — Eric]** GCP setup per `ERIC-SETUP.md` (~10 min) +
   reply with the Project ID. Plus, at deploy time, one push tap and
   one 30-second `MONGODB_URI` paste.
2. **[BLOCKED — piece (b)]** Finder-runner image + `job.yaml` lands
   in `cloud-run/runner/` (parallel agent's piece). `deploy-job.sh`
   fails fast until it exists.
3. **[After 1–2]** Push migration files to GitHub (parent handles;
   needs Eric's standard push approval tap), clone in Cloud Shell,
   run `./cloud-run/deploy-all.sh <PROJECT_ID> <BILLING_ACCOUNT_ID>`.
4. **[After 3]** 14-employer canary on the new host (same canary set
   as the Vercel rounds: Foundever, Sitel, Teleperformance, Omni,
   Working Solutions, Day Kimball, etc. — all 14 must return their
   correct answer).
5. **[After 4]** Full-roster sweep with auto-add on the new host.
6. **[After 5]** Billing check: confirm the month's Cloud Run usage
   and the $1 budget state; confirm the sweep's real vCPU-s against
   the 70,000 estimate.

## What is NOT done yet

- Deployment itself (blocked — see top of this file).
- Canary + sweep on the new host (await deployment).
- Billing verification against a real run (await deployment).
- Piece (b) runner image + `job.yaml` (parallel agent; not in this
  piece's scope, but `deploy-job.sh` depends on it).
- No live board writes, no sweeps, and no employer-site fetches from
  the VM were done in this piece — per the brief.

## Files in this piece

| File | What it is |
|---|---|
| `cloud-run/service.yaml` | Service spec: cpu 1, 512Mi, min 0 / max 2, concurrency 80, timeout 300s, port 8080, secrets as references, image `gcr.io/PROJECT_ID/jobboard-service:latest` |
| `cloud-run/deploy-service.sh` | Deploy service from source (Cloud Build in GCP), print URL |
| `cloud-run/deploy-job.sh` | Deploy/update job from `runner/job.yaml` (fails fast if piece (b) missing) |
| `cloud-run/deploy-all.sh` | Secrets → service → job → budget alert, in order, fails fast |
| `cloud-run/set-env.sh` | Secrets into Secret Manager; `MONGODB_URI` via stdin/file/silent paste, `SYNC_KEY` from local file; grants runtime service account read access; never prints a value |
| `cloud-run/budget-alert.sh` | $1 budget, project-scoped, 50/90/100% actual + 100% forecasted, email alerts |
| `cloud-run/budget.yaml` | Declarative record of that budget (budgets have no `apply -f`; created by the script/API) |
| `cloud-run/ERIC-SETUP.md` | Blocked record of the setup that would be needed (not a request) |
| `cloud-run/README.md` | This file |
