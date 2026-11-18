# ATS Resolver Pilot — plan + status (2026-11-17)

## What the pilot is
Resolve the first 500 usable companies from the roster to their ATS
(Greenhouse / Lever / Ashby / Workday / SmartRecruiters / iCIMS / Taleo /
other / unresolved) and report the ATS distribution BEFORE any crawler is
written. That distribution decides which fetchers get built first.

## Roster reality (measured, not assumed)
- Source: `~/workspace/jobboard/roster-2026-11-12.json` — 39,776 entries,
  keyed by company name: `{ name, website, careersUrl }`.
- 35,273 have a usable website hostname (domain derived from `website`).
- 4,499 are social/aggregator links (Facebook, LinkedIn, etc.) — skipped.
- 4 unparseable. 0 have `careersUrl` filled in — the pilot must try
  `/careers`, `/jobs`, `/careers/`, `/about/careers` itself.
- Pilot shard: `pilot-500.json` — first 500 usable domains, sorted by name
  (first `.NET Foundation`, last `Adventist Rehabilitation Hospital of
  Maryland`). Generated dry-run only, no network.

## How it runs
- `src/resolve-run.cjs --live` in GitHub Actions only (5 matrix shards x 100).
  Workflow: `.github/workflows/resolve.yml` (in this dir — copy into the
  repo at push time, DO NOT push now).
- Per company: fetch careers paths (10s timeout, ~3 req/s, polite UA),
  run `resolveAts` on the raw HTML. Accept a board ONLY if the company's
  own domain links to it (own-careers-page proof, prevents slug collisions).
- Report: `ats-distribution.json` — checked count, crawlable count + %,
  per-ATS counts. A company counts as crawlable only when a slug/tenant
  was extracted, not merely when the ATS family was detected.

## Blockers (plain)
1. **Live pilot needs the push.** The workflow + scripts live in
   `~/workspace/jobboard/rebuild-2026-11-17/` only. jobboard is NOT in the
   standing push-permission list, so nothing has been pushed. Push needs
   Eric's go-ahead; the push contains: `src/` (verifier, db, resolver),
   `pilot-500.json`, `.github/workflows/resolve.yml`, `schema.sql`.
2. **Live pilot cannot run from the VM.** Direct fetches to employer sites
   pop per-site approval cards (Eric refused these on 2026-11-11). The
   resolver was validated locally on 12 canned-HTML fixtures instead
   (12/12 pass) — the live run happens in Actions after the push.
3. **Turso is out.** It needs an account signup the agent cannot do. The
   store is the SQLite-file fallback (Mistral's route): Actions builds
   `jobs.db`, Render serves it read-only + a static `jobs.json` snapshot.

## What the pilot decides
- If Greenhouse/Lever/Ashby dominate → build those 3 fetchers first (step 4).
- If Workday dominates → Workday adapter moves up (it is the fiddliest).
- If unresolved is >60% → the 40k roster is mostly not addressable; the
  board starts from the resolved subset (100–300 verified employers first,
  per Perplexity/Genspark), not from 40k.
