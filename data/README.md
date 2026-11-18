# data/ — ingest data files (in the repo under jobboard-rebuild/data/)

Everything here is generated or hand-maintained. Nothing in this dir is
fetched live by the VM — live runs happen in GitHub Actions only.

## Files

| File | Who writes it | What it is |
|---|---|---|
| `resolved.json` | resolve.yml report job | Merged resolver results: every company the resolver checked, with ATS + slug/tenant + crawlable flag. Ingest never runs without this. |
| `us-allowlist.json` | A HUMAN, by hand | Companies whose US HQ is verified with first-party evidence. **The only source of `usVerified`.** Ingest skips any company not on this list — fail-closed by design. |
| `companies.json` | ingest.yml setup job (build-companies.cjs) | Ingest-ready company records with tiers, rebuilt every ingest run from resolved.json + allowlist + jobs.db yield history. Derived — do not hand-edit; it is committed only so a run is auditable. |
| `jobs.db` | ingest.yml merge job | Canonical SQLite store (schema in src/schema.sql). Only verified-live, unexpired jobs are served from it. |
| `jobs.json` | ingest.yml merge job / reverify.yml | Public snapshot: `listLiveJobs` output (id, company, title, URL, location, excerpt, first/last verified). This is what Render serves. |
| `shards/jobs-<N>.db` | ingest.yml merge job | Per-shard SQLite files. Each shard owns disjoint companies (md5 hash mod N) and starts its next run from its own file, so closeMissing has the last_seen history it needs to close a job only after 2 consecutive misses. |

## us-allowlist.json format

```json
{
  "version": 1,
  "companies": [
    {
      "domain": "acme.com",
      "hqCountry": "US",
      "evidenceUrl": "https://acme.com/about — 'Headquartered in Austin, Texas'",
      "verifiedAt": "2026-11-17T00:00:00.000Z"
    }
  ]
}
```

Rules (SYNTHESIS-DRAFT.md — all 7 consults agree):
- HQ evidence must be FIRST-PARTY: the company's own About / investor /
  careers page stating its headquarters, or SEC EDGAR for public cos.
- NEVER accept as HQ evidence: `.com` domain, USD salary, US phone
  number, a "US remote" label, or a US contact/mailing address.
- `verifiedAt` + 180 days = `usExpiresAt`. Expired entries do NOT verify —
  the company drops to tier `held` until someone re-verifies it.
- Foreign parent with a US subsidiary: list the subsidiary ONLY if it is
  the named hiring employer and its own US HQ is verified.
- Do NOT fabricate entries. An empty list means ingest is a no-op, and
  that is correct — the board starts from 100–300 verified employers,
  not from the 40k roster.

## Tier rules (build-companies.cjs)

- **A** — resolved + crawlable + US-verified + ever yielded a verified
  job → ingested every 30 min (ingest.yml Tier A cron).
- **B** — resolved + crawlable + US-verified + never yielded → daily.
- **C** — unresolved ATS → monthly re-probe via resolve.yml, never ingested.
- **held** — resolved but NOT US-verified → never ingested. HQ evidence
  work is a manual step, not an agent guess.

## Repo-size note

jobs.db + shard DBs are committed binaries. Expected size is small
(hundreds of KB — descriptions are stored as ~10–12 KB excerpts, full
text only for passed versions). If the repo ever gets heavy, the escape
hatch is: stop committing shard DBs and have shard jobs download the
previous shard db via `gh api` artifact download instead. Do not do
that pre-emptively — plain checkout is simpler and self-contained.
