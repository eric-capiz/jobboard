# JobBoard finder-runner — piece (b) notes

## Status (2026-11-12, ~19:55–21:05 MST)

**Piece (b) files: COMPLETE. Image build: BLOCKED on the round-21 commit.
Formal fixture canary: BLOCKED on the round-21 commit (plumbing check
passed — see below). Live 14-employer canary: awaits deployment.
Deployment itself: BLOCKED — zero-input is absolute (Eric, 19:46 MST:
"Im not setting up anything. Its all on u."). No GCP project, billing
account, gcloud auth, or Secret Manager secrets exist; see
cloud-run/README.md "Why zero-input deployment is impossible".**

## The round-21 block (read first)

The remote head is still `47fea165` (round 20), checked via GitHub
`list_commits` on eric-capiz/jobboard at 19:53 and 20:53 MST. A round-21
commit is being pushed fixing 6 systemic bugs the board verification
found: (1) test-company isUSCompany bug, (2) extractor accepting
job-board apply links (e.g. LinkedIn), (3) title-embedded locations
invisible to the location check, (4) "on-call" passing the CS gate on
the token "call", (5) category/blog pages extracted as postings,
(6) gate holes for housekeeping/energy/teaching roles. Evidence (read
only): `verify401/verdicts-v3.json` + `removed-2026-11-12.json`.

**Rules that governed this piece:**
- Build ONLY from the head AFTER the round-21 commit — never from
  `47fea165`.
- The formal fixture canary runs against the post-round-21 code.
- What was done instead: everything else, plus a PLUMBING check of the
  canary harness against the current code (85/85 — see "What was
  verified"), clearly labeled as plumbing, NOT the formal canary.
- The `dist-server/server.mjs` bundle built during this piece was from
  `47fea165` code and has been DELETED so it cannot be mistaken for a
  post-round-21 artifact. The Dockerfile rebuilds it from the current
  head in stage 1.

**Rerun checklist after round-21 lands (in order):**
1. Check the remote head (`/opt/hatch/bin/github call-read-tool
   --name list_commits` on eric-capiz/jobboard) — must be past round-21.
2. Sync the working copy to the round-21 head. This repo has NO .git,
   so that means a fresh checkout/tarball at the new head (the
   coordinator owns the sync). Do NOT hand-edit `api/` to fake it.
3. Re-run `./cloud-run/runner/build.sh` (rebuilds the bundle).
4. Re-check the canary expectations against round-21's updated
   `local-verify/driver.ts` / FakePage counts FIRST — round-21 can
   deliberately change fixture outcomes (e.g. the isUSCompany fix
   changes how test-company treats blank-location leads; the board-link
   fix changes what counts as a posting). A failure on a case round-21
   deliberately changed is an EXPECTATION update in
   `canary-fixtures.mjs`, not a runner regression. Judge against the
   round-21 evidence.
5. Re-run `node cloud-run/runner/canary-fixtures.mjs` — must print
   `LOCAL-FIXTURE-CANARY-ALL-PASS` before any image build is trusted.
6. Only then is the image build (`deploy-job.sh`, which runs
   `gcloud builds submit`) meaningful. Deployment itself still awaits
   the GCP setup in `ERIC-SETUP.md`.

## Files in this piece

| File | What it is |
|---|---|
| `cloud-run/runner/server.mjs` | Runner server: Node http adapter for /api/find-jobs + /api/test-company ONLY, with Chromium warmup. Fork of `cloud-run/server/server.mjs` (see header — opposite render policy, no static serving). |
| `cloud-run/runner/build.sh` | Bundles the runner server + api/ with esbuild (ESM; mongodb, @sparticuz/chromium-min, puppeteer-core external) → `cloud-run/runner/dist-server/server.mjs`. Mirror of `cloud-run/server/build.sh`. |
| `cloud-run/runner/sweep-driver.mjs` | Sweep driver: loops /api/find-jobs chunks, checkpoints after every chunk, render throttle. Node port of `sweep-2026-11-12-cs-v6/worker-*.py`. |
| `cloud-run/runner/canary-fixtures.mjs` | Fixture canary: 19 cases over the local-verify fixtures against the local runner (9 of 14 employers; 5 have no fixture). |
| `cloud-run/runner/Dockerfile.runner` | Multi-stage runner image (build + node:22-slim runtime WITH Chromium system libs). |
| `cloud-run/runner/job.yaml` | Cloud Run Job spec: `jobboard-finder`, 1 vCPU / 2Gi, 24h timeout, maxRetries 3, restartPolicy Never. |
| `cloud-run/deploy-job.sh` | EXTENDED (was piece (c)'s file): added the Cloud Build image-build step before `gcloud run jobs replace` (SKIP_BUILD=1 to skip). Everything else untouched. |

**Path note (deviation from the original brief):** the brief said
`cloud-run/job.yaml`; the landed tooling (`deploy-job.sh`,
`cloud-run/README.md`) expects `cloud-run/runner/job.yaml`. The file
lives at `cloud-run/runner/job.yaml` to match the tooling that
consumes it.

**Secret names:** the brief said `jobboard-mongodb-uri` /
`jobboard-sync-key`; the landed `set-env.sh` creates `mongodb-uri` and
`sync-key`. `job.yaml` uses the landed names.

## Dockerfile.runner

- **Stage 1 (build):** `node:22-slim`, `npm ci` (full deps — esbuild
  arrives via vite's tree, same as the service image), selective COPY
  (`package*.json`, `api/`, `cloud-run/runner/`), `./cloud-run/runner/build.sh`.
  NO vite build: the runner never serves the SPA, so `dist/` is not
  built or copied.
- **Stage 2 (runtime):** `node:22-slim` + the Chromium system libs
  (below) + `npm ci --omit=dev`, then the bundled server, the sweep
  driver, the fixture canary, and the three demo-resume `.txt` files
  at `/app/resumes/` (the driver needs a resume FILE;
  `RESUME_PATH` defaults to
  `/app/resumes/demo-customer-service.txt`). Runs as `USER node`.
  Default CMD runs the finder server (handy for a debug service); the
  Job overrides the command with the sweep driver (see `job.yaml`).
- **Chromium:** `@sparticuz/chromium-min` ships its binary as a
  Brotli pack, NOT in the npm package. The runner resolves it at
  startup (warmup in `server.mjs`) by downloading the pinned v153.0.0
  pack (~70MB) from the @sparticuz/chromium GitHub releases into
  `/tmp` and extracting it there; later renders in the same container
  reuse it. The download needs egress to github.com at container start
  only. The pack URL is pinned in both `api/render-page.ts` and
  `cloud-run/runner/server.mjs` — keep the two in sync.
- **System libs:** the @sparticuz/chromium-min README does NOT
  enumerate the required Debian packages (it only says to install
  Chromium's dependencies from the distribution's repositories when
  using a Dockerfile), so the Dockerfile uses Puppeteer's canonical
  documented Debian list, kept whole rather than trimmed (see the
  Dockerfile header for what each group is for: libnss3/libnspr4 for
  cert validation, libatk for the accessibility tree, libgbm1 for
  graphics buffers, libasound2/libcups2/libgtk-3-0 linked at startup,
  the libx* client libs, pango/cairo/fontconfig + fonts-liberation for
  text, dbus/glib/runtimes, ca-certificates for TLS). Headless_shell
  needs only a subset, but trimming is untested and a missing lib fails
  the launch mid-sweep. The full list was confirmed as valid Debian 12
  bookworm package names via the Pollinations review (see below).

## Sweep driver (`sweep-driver.mjs`)

Node port of the Python sweep workers (`worker-*.py`): same request
shape (`{resumeText, cursor, limit, autoAdd, resumeLabel}` + the
`x-sync-key` header), same retry-then-skip-a-cursor policy, same
checkpoint fields — so a run driven by this file is comparable to the
Vercel sweeps chunk for chunk.

- **Managed server (default, `FINDER_MANAGED_SERVER=1`):** the driver
  spawns the runner server bundle as a child on 127.0.0.1
  (`FINDER_PORT`, default 8080), waits for `/healthz`, runs the sweep,
  SIGTERMs it at the end. A Cloud Run Job runs ONE container = ONE
  command, so the driver must own the server process. The child
  inherits `MONGODB_URI` from the job env and gets `SYNC_KEY` from the
  key file in-memory only. Set `FINDER_MANAGED_SERVER=0` to point at
  an already-running server instead (local testing).
- **Checkpointing:** atomic write (tmp file + rename) after every
  chunk to `CHECKPOINT_PATH` (job.yaml: `/tmp/sweep-checkpoint.json`).
  Stores cursor, checked, leads, autoAdded, statsTotals, failedCursors,
  renderTimestamps, startedAt/updatedAt, done. Resumes from it on
  start; a corrupt checkpoint logs a warning and starts fresh. The
  checkpoint NEVER carries the resume text or the sync key (verified —
  see below). LIMITATION (honest): a retried task attempt is a NEW
  container, so it does NOT see the old checkpoint and restarts from
  cursor 0. That is safe (server auto-add dedupes by title+company)
  but wasteful. A persistent checkpoint (e.g. a GCS volume mount) is a
  future improvement, not wired here.
- **Retries:** up to `MAX_ATTEMPTS` (default 3) per chunk with
  `RETRY_DELAY_MS` (default 5000) between attempts; on 401/403 the key
  file is re-read once (and the managed server restarted so the new
  key takes effect); after all attempts fail the cursor is recorded in
  `failedCursors` and the driver advances by `LIMIT`.
- **Exit codes:** 0 = sweep finished (done, `SWEEP_END`, or
  `MAX_CHUNKS`) even with some failed cursors (they are recorded);
  1 = unrecoverable (resume/key unreadable, server never healthy,
  auth failing, checkpoint unwritable, bad config such as
  `MAX_RENDERS_PER_HOUR=0`). A 1 on a Job task triggers a retry
  (maxRetries 3).
- **Env vars:** `FINDER_BASE_URL` (default http://127.0.0.1:8080),
  `FINDER_MANAGED_SERVER`, `FINDER_PORT`, `RESUME_PATH` (required),
  `SYNC_KEY_PATH` (required), `RESUME_LABEL` (default
  demo-customer-service), `AUTO_ADD` (default true), `LIMIT` (default
  25), `CHECKPOINT_PATH`, `SWEEP_END`, `MAX_CHUNKS`, `RENDER_DELAY_MS`
  (default 5000), `MAX_RENDERS_PER_HOUR` (default 120),
  `CHUNK_TIMEOUT_MS` (default 120000), `RETRY_DELAY_MS` (default
  5000), `MAX_ATTEMPTS` (default 3).

### Throttle math vs the free tier

Free tier (Cloud Run Jobs, us-central1, per billing account per month
— verified by piece (c) from Google's pricing page, 2026-11-13):
240,000 vCPU-s + 450,000 GiB-s. Overage: $0.000018/vCPU-s,
$0.000002/GiB-s.

- One full sweep ≈ 70,000 vCPU-s (rebuild estimate — NOT yet confirmed
  by a real run on Cloud Run; confirm from the first sweep's billing
  data). At 1 vCPU that is ~70,000s ≈ 19.4h of wall time, which fits
  the 24h task timeout (40,081 companies / 25 per chunk = ~1,604
  chunks; the Vercel v4 sweep took ~1.5h with 8 parallel workers, so a
  single serial task at ~30–45s/chunk lands in the same 13–20h band).
- CPU: 70,000 / 240,000 ≈ **29% of the Jobs CPU tier**.
- Memory: 2 GiB × 70,000 s = 140,000 GiB-s ≈ **31% of the Jobs memory
  tier**. (Piece (c)'s README quoted 35,000 GiB-s / 8% at 512Mi; the
  job runs at 2Gi because Chromium needs it, so the memory share is
  4× that. CPU and memory end up roughly equal at ~30% each.)
- One sweep fits with ~3× headroom on both. Worst case if the tier
  were already exhausted: 70,000 × $0.000018 + 140,000 × $0.000002 ≈
  **$1.54** for a full sweep — the maximum plausible overage, not a
  prediction. The prediction is $0.
- **The throttle:** `MAX_RENDERS_PER_HOUR=120` caps render attempts
  in any rolling hour; `RENDER_DELAY_MS=5000` sleeps after any chunk
  that rendered. Renders are the CPU-hot part (a warm render is ~5–10s
  of mostly-Chromium CPU; a cold first render ~30s), but they are rare
  (v4 sweep: 35 renders per 40,081 companies). Realistic render CPU
  for a sweep is a few hundred renders × ~15 vCPU-s ≈ 4,500 vCPU-s
  (~2% of the tier). The cap's real job is the pathological case: if
  every company needed renders, 120/hour bounds render CPU at ≤3,600
  vCPU-s/hour, so the driver sleeps instead of blowing the monthly
  tier in one run. Verified live in the stub test (see below): a
  pre-seeded render timestamp made the driver sleep exactly 61s until
  the rolling window cleared.

## job.yaml

`jobboard-finder`: parallelism 1, taskCount 1, `taskTimeout: 86400s`
(24h), `maxRetries: 3`, `restartPolicy: Never`, container cpu 1 /
memory 2Gi, command `node runner/sweep-driver.mjs`, image
`gcr.io/PROJECT_ID/jobboard-runner:latest` (PROJECT_ID substituted by
`deploy-job.sh`). Env: the driver vars above + `MONGODB_URI` from
Secret Manager secret `mongodb-uri` (secretKeyRef, key `latest`) and
`SYNC_KEY` mounted as a file at `/secrets/sync-key` from secret
`sync-key` (secret volume, key `latest` → path `sync-key`). The job
runs as the Compute Engine default service account, which `set-env.sh`
grants `secretAccessor` on both secrets.

## deploy-job.sh (extended)

Piece (c)'s script already did pre-flight, piece-(b) existence checks,
and `gcloud run jobs replace`. It did NOT build the image the job
references — nothing did. Added one step (everything else untouched):
`gcloud builds submit --tag gcr.io/$PROJECT_ID/jobboard-runner:latest
--file cloud-run/runner/Dockerfile.runner .` (Cloud Build builds in
GCP; no local Docker ever), skippable with `SKIP_BUILD=1`. The script
still runs wherever gcloud is already authenticated and assumes
nothing about who authenticates it — per the zero-input order it
cannot run on this VM at all (no gcloud, no project, no billing).

## What was verified locally (exact commands + results)

All runs used ONLY the local-verify fixtures and the local runner.
No live employer site was fetched, the live Vercel app was never
called, no sweep ran, nothing wrote to the board.

1. **Chromium pack (real binary, not a stand-in).** The first attempt
   used the Playwright 156 headless_shell already on the VM as a
   stand-in for `/tmp/chromium` — it FAILED to launch with the exact
   sparticuz args (`Target.setDiscoverTargets: Target closed`, and
   `--single-process` variants died too). The real sparticuz 153 pack
   was then downloaded from GitHub releases with
   `TMPDIR=$PWD/.chromium-tmp node -e "chromium.executablePath(...v153.0.0-pack.x64.tar)"`
   — extracted in ~20s with NO approval card (github.com is
   proxy-allowed), and the probe launched clean with the exact
   `render-page.ts` args (`LAUNCH-OK`). Lesson: the Playwright 156
   binary does NOT tolerate the sparticuz arg set; the real 153 pack
   does. The `.chromium-tmp` scratch dir was deleted after verification
   (the canary re-downloads the pack on first run if it is absent).
2. **`npm run build` (tsc + vite): clean** — 20.08s, `✓ built`.
   (Runs in the service image's stage 1; the runner image skips it
   by design.)
3. **Runner bundle:** `./cloud-run/runner/build.sh` → 109.1KB ESM
   bundle, `node --check` clean. Server started: `GET /healthz` →
   `{"ok":true,"service":"jobboard-runner"}`, `GET /readyz` →
   `{"ok":true,"chromium":"warming"}` (warmup resolves the pack after
   listen). Bundle since DELETED (pre-round-21 artifact — see top).
4. **Fixture canary — PLUMBING CHECK ONLY (NOT the formal canary):**
   `node cloud-run/runner/canary-fixtures.mjs` → exit 0 in ~154s:
   `CANARY-RESULT passes=85 failures=0 skipped=5`,
   `LOCAL-FIXTURE-CANARY-ALL-PASS`. 19 cases, 9 employers (Foundever,
   Sitel + slug variant, Teleperformance + iCIMS, TTEC, Alorica +
   zero + gated, NexRep + JS, Working Solutions + FAQ, Omni + links +
   blog + corporate, Kelly) plus probe mode — plain-HTML extraction,
   real Chromium renders, portal search gates, CS gate and location
   rules all returned their driver.ts-expected answers through the
   HTTP runner (not the in-process driver). Skipped (no fixture):
   Concentrix, Sutherland, Day Kimball, NSSF, AIR. **This ran against
   the 47fea165 code. It proves the harness works; the FORMAL canary
   must be re-run post-round-21.**
5. **Sweep driver against a stub /api/find-jobs server**
   (`/tmp/stub-find-jobs.mjs`, since removed): 4 runs, all as designed.
   - Run 1 (full): chunks 0/25/50/75 — cursor 25 HTTP-500'd twice,
     was skipped and recorded; FINISHED checked=75 leads=2 autoAdded=2
     renders=3 failedCursors=[25], exit 0. Checkpoint had correct
     totals, no resume text, no sync key (grep count 0).
   - Run 2 (resume): MAX_CHUNKS=1 stopped at cursor 25
     (checkpoint lastCursor=25, checked=25, leads=1, done=false);
     rerun resumed at 25, skipped the 500 cursor, finished;
     third run exited immediately ("checkpoint already says done").
   - Run 3 (401): wrong key → "got 401; re-read key file, retrying",
     still 401 → cursors skipped to SWEEP_END=50, failedCursors=[0,25].
   - Run 4 (managed server): driver spawned the real runner bundle,
     healthy in ~4s; chunks timed out client-side at 8s (no MongoDB on
     this VM — the handler hung in server selection), skipped cursor 0,
     SWEEP_END stopped it, server exited code 0, no orphan process.
   - Cap test: checkpoint pre-seeded with 1 render timestamp 59 min
     old, MAX_RENDERS_PER_HOUR=1 → "render cap reached (1/1 in the
     last hour); sleeping 61s", chunk ran at +60s exactly.
   - Bugs found by these tests and fixed in the driver: (a) `let
     baseUrl` in main() shadowed the module-level one `postChunk`
     reads, so a managed server on a non-default port would never be
     used; (b) `MAX_RENDERS_PER_HOUR=0` would deadlock
     `enforceRenderCap` — now fails fast at startup; (c) the resume
     text was briefly stored on the checkpoint state object — now kept
     in a module variable and explicitly stripped from checkpoint
     writes.
6. **job.yaml parses:** `python3 -c yaml.safe_load` → kind Job,
   name jobboard-finder, taskTimeout 86400s, maxRetries 3,
   restartPolicy Never, 1 container, secret volume
   `{secretName: sync-key, items: [{key: latest, path: sync-key}]}`.
7. **Dockerfile COPY paths:** all 10 COPY sources verified to exist
   in the repo root (package.json, package-lock.json, api/,
   cloud-run/runner/*, the three demo-resume .txt files).
8. **Pollinations outside-AI review (text API only; Gemini vetoed):**
   - job.yaml (full file pasted): **"NO ISSUES FOUND."**
   - Dockerfile + job.yaml together (17.7k-char URL): empty reply
     from the server (curl rc 52) — too long, no result.
   - Dockerfile alone (9.7k-char URL): the model errored
     (`output_token_limit_exceeded`) — no result, not a finding.
   - Apt package list alone (short prompt): **"YES / ALL VALID"**
     for all 41 Debian 12 bookworm package names.
   So: the job.yaml structure and the apt list have outside-AI
   confirmation; the full Dockerfile review produced no usable
   answer, and the Dockerfile stands on the COPY-path checks,
   the build.sh verification, and the line-by-line review in its
   header instead.

## What was NOT verified (do not claim otherwise)

- **Actual `docker build`.** No Docker/podman/gcloud on this VM
  (verified: `which docker podman gcloud` → nothing). The Dockerfile
  was validated by review only: COPY paths exist, stage-1 commands
  (`npm ci`, `build.sh`) were run locally and pass, the apt list was
  confirmed valid package names. The first real `docker build` /
  Cloud Build happens at deploy time, in GCP.
- **The formal fixture canary.** Blocked on the round-21 commit (see
  top). The 85/85 plumbing check ran against 47fea165 code.
- **The LIVE 14-employer canary on the new host.** Still awaits
  deployment and cannot run from this VM. The 5 no-fixture employers
  (Concentrix, Sutherland, Day Kimball, NSSF, AIR) can ONLY be proven
  by that live canary.
- **`gcloud run jobs replace` / `gcloud builds submit`.** No gcloud
  here; the commands in `deploy-job.sh` are untested invocations.
  The job.yaml field placement passed the Pollinations structural
  review and parses as YAML, but `gcloud` is the final validator.
- **A real full-roster sweep on Cloud Run.** No sweep ran (per the
  brief). The 70k vCPU-s estimate, the 19h wall-time band, and the
  free-tier percentages are arithmetic on that estimate, not measured.
- **Chromium launch inside the Docker image.** Proven with the real
  153 pack on this VM (same binary, same args), NOT inside
  node:22-slim — the system libs are installed by the Dockerfile but
  were never apt-installed anywhere in this verification. A missing
  lib would surface as a launch failure on the first render in GCP;
  the driver treats a failed render as a chunk-level event (retry,
  then skip), so it degrades rather than crashing the job — but it
  would still need a Dockerfile fix.

## Cleanup done at the end of this piece

- Deleted `cloud-run/runner/dist-server/` (47fea165 bundle).
- Deleted `~/workspace/jobboard/.chromium-tmp/` (210MB extracted
  Chromium scratch).
- Deleted `/tmp` test files (stub server, stub/wrong key files,
  driver test checkpoints) and the `/tmp/chromium` stand-in files.
- No stray processes left (verified: no `stub-find-jobs` or
  `dist-server` processes).
- No repo SOURCE files outside `cloud-run/` were modified. `dist/`
  was regenerated by `npm run build` (same source; build output
  only). `api/`, `src/`, `local-verify/`, and the sweep archives are
  untouched.
