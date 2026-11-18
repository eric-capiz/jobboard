# JobBoard rebuild — consensus synthesis (DRAFT, 7 of 8 consults)
Date: 2026-11-17. Consults in: Pollinations, Claude, DeepSeek, Genspark, ChatGPT, Mistral, Perplexity. Pending: Qwen. Finalize when Qwen lands.

## The one-sentence route
Render serves a read-only board. Everything else — discovery, fetching, verification — runs on scheduled GitHub Actions against public ATS JSON endpoints, with a fail-closed deterministic verifier at ingest. Nothing enters the board unverified.

## What all 7 agree on
- **Render never crawls.** It serves published jobs only. All discovery + verification happens in GitHub Actions (public repo = free runners; private caps at 2,000 min/mo). Keepalive commit needed — scheduled workflows auto-disable after 60 days with no repo activity.
- **ATS JSON endpoints are the primary source** — no browser for the main path. First wave: Greenhouse `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`, Lever `api.lever.co/v0/postings/{slug}?mode=json`, Ashby `api.ashbyhq.com/posting-api/job-board/{slug}`. Later: Workday CXS POST (undocumented, Akamai-throttled, limit silently caps at 20, 10k-result cap), SmartRecruiters (detail call needed). iCIMS/Taleo have no public API — park as unresolved, or tenant-specific HTML / Playwright in CI only for named employers.
- **Full posting text is the source of truth.** Structured flags are prefilter only, never proof. Ashby `isRemote` is true for Hybrid too — never gate on it. Greenhouse has no remote field at all. Bare "Remote" label does not count.
- **Fail-closed, reject-by-default.** Hard-reject: hybrid, on-site, in-office, "N days per week", travel %, "must reside/live in [state/city]", relocation, non-US regions, non-USD currency. Positive remote evidence REQUIRED: "fully remote", "100% remote", "work from anywhere in the US", "remote within the United States", "telecommute". Blank location = automatic fail (DeepSeek + my own position — blank was the exact failure mode).
- **US-based needs two independent checks:** employer HQ in the US (SEC EDGAR for public companies, About/footer, Wikidata/OpenCorporates; never TLD, .com, salary, or phone) AND posting US eligibility. "US-wide remote" is not the same as "US employer". Two-of-three sources or a company allowlist; Perplexity: employer evidence expires after 180 days.
- **Store the evidence span on every verdict** — the matched sentence + source field — so every listed job is auditable.
- **Dedupe:** primary (company, ATS, ATS job id); secondary content hash (company + normalized title + description); normalize URLs (strip utm_/gh_src/lever-source). Workday: strip the location segment from externalPath before keying.
- **Staleness from live facts, never age:** full snapshot per fetch; missing from 2 consecutive successful fetches = closed; never close from a partial or errored crawl; a whole board going empty = unknown, never mass closure. Re-verify on content-hash change + full cycle every 14 days (Perplexity proposes a stricter 48h freshness budget — if free execution can't hold it, shrink the employer set, don't extend the limit).
- **The 309 checked postings become the regression fixture set.** No classifier ships until it produces zero false accepts on that set. Audit the first 100 published jobs manually, then 25 random live jobs weekly; every false accept becomes a fixture + a rule.
- **No LLM adjudicator at first.** Ship the fail-closed regex gate, read the reject log for a week, add adjudication only if good jobs are being dropped. The board must be correct with the LLM switched off.
- **Reality check (Genspark, Perplexity):** expect a SMALL board — hundreds to a couple thousand live roles, not tens of thousands. 25–40% of the 40k roster resolves to a machine-readable ATS board; low single digits of postings survive a strict gate. Start with 100–300 verified employers, not 40,000. Treat the roster as discovery inventory, not a promise.

## Where they disagree — the store (no consensus, decision needed)
- Claude + DeepSeek: Neon free Postgres (0.5–1GB, 100 CU-hours).
- ChatGPT: Cloudflare D1 (500MB/db, enforced daily row limits).
- Genspark: Turso (HTTP SQLite, 5GB, no cold start).
- Mistral: SQLite file built in Actions, pushed to Render.
- Perplexity: Supabase Free Postgres (500MB, projects pause after 1 week inactive).
- My pick: Turso. The board's whole failure mode is sleeping services — Neon scales to zero (cold start on top of Render's sleep), D1 caps at 500MB with enforced daily limits, Supabase pauses after a week idle. Turso is HTTP-based with no cold start and allowances far above this workload. Decide with Eric if he wants Postgres familiarity instead.

## Build order (consensus)
1. Golden test set from the 309 logged verdicts; verifier as pure functions; gate = 0 false accepts.
2. Schema + store (Turso, decision above) + Render read-only API.
3. ATS resolver over the roster, piloted on 500 companies; report ATS distribution before writing any crawler.
4. Greenhouse / Lever / Ashby fetchers + verifier, sharded Actions matrix; frequency tiering (Tier A: ever yielded, 30 min; Tier B: resolved never yielded, daily; Tier C: unresolved, monthly re-probe).
5. Lifecycle: snapshot-diff closing, liveness checks, dedupe, expiry enforced in the public query.
6. SmartRecruiters + Workday adapters.
7. Playwright tier for iCIMS / Taleo / custom, weekly, hard per-run budget.
8. LLM adjudicator ONLY if the reject log shows good jobs dropped.
9. Weekly audit: 25 random live jobs; false accepts become fixtures + rules.

## Prediction #9 status (open, resolves when Qwen lands)
(a) 5+ of 7 browser AIs return usable answers — already TRUE (7 of 7 usable so far; Qwen pending). (b) Most likely blocker = sign-in walls — TRUE in substance: Mistral/Perplexity/Qwen all needed sign-in handling, solved via device browser + emailed codes. (c) Consensus route = GitHub Actions + ATS JSON endpoints — TRUE, 7/7.
