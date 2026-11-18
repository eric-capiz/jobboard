-- schema.sql — JobBoard ingest store (SQLite file).
-- Built by GitHub Actions (ingest pipeline), served read-only by Render.
-- The live board's 28 Applied records live in the SEPARATE state API and
-- are NEVER stored here. This file holds only verified-ingest data.
-- Store decision: Turso needs an account signup the agent cannot do, so the
-- fallback is Mistral's route — Actions builds this SQLite file and Render
-- serves it (plus a static jobs.json snapshot). No cold start, no $0 service
-- beyond what already exists.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,               -- normalized domain, e.g. acme.com
  name TEXT,
  domain TEXT NOT NULL,
  careers_url TEXT,
  ats_type TEXT,                     -- greenhouse | lever | ashby | workday | smartrecruiters | icims | taleo | custom | unresolved
  ats_slug TEXT,
  ats_host TEXT,
  ats_site TEXT,
  ats_evidence_url TEXT,            -- the careers-page URL that proved the ATS link
  hq_country TEXT,                   -- 'US' when verified, else NULL
  us_verified INTEGER NOT NULL DEFAULT 0,
  us_evidence_url TEXT,
  us_verified_at TEXT,
  us_expires_at TEXT,                -- Perplexity: 180 days
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,               -- company_id || '|' || ats_type || '|' || ats_job_id
  company_id TEXT NOT NULL REFERENCES companies(id),
  ats_type TEXT NOT NULL,
  ats_job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  location TEXT,
  description_excerpt TEXT,          -- first ~10-12 KB only (Genspark sizing rule)
  content_hash TEXT NOT NULL,        -- sha256(title + company + first 500 tokens of description)
  structural_hash TEXT NOT NULL,     -- company + normalized title + normalized location
  status TEXT NOT NULL DEFAULT 'live', -- live | expired | rejected
  verification_state TEXT NOT NULL DEFAULT 'pending', -- pending | passed | failed
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  consecutive_misses INTEGER NOT NULL DEFAULT 0, -- round 5: persistent count of consecutive successful-run misses; close at 2 (replaces the last_seen > 24h age heuristic, which closed on the FIRST miss for daily Tier B and kept removed jobs live ~24h for 30-min Tier A)
  last_verified_at TEXT,
  verification_expires_at TEXT,      -- hide from public query after this
  closed_reason TEXT,
  UNIQUE (company_id, ats_type, ats_job_id)
);
CREATE INDEX IF NOT EXISTS idx_postings_live ON postings(status, verification_state, last_verified_at);
CREATE INDEX IF NOT EXISTS idx_postings_structural ON postings(structural_hash);
CREATE INDEX IF NOT EXISTS idx_postings_company ON postings(company_id);

CREATE TABLE IF NOT EXISTS posting_versions (
  posting_id TEXT NOT NULL REFERENCES postings(id),
  content_hash TEXT NOT NULL,
  description TEXT NOT NULL,         -- full text, only for versions that passed
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (posting_id, content_hash)
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id TEXT NOT NULL REFERENCES postings(id),
  verdict TEXT NOT NULL,              -- ACCEPT | REJECT
  reason TEXT NOT NULL,               -- reason code from verifier.js
  evidence TEXT,                      -- matched sentence / evidence span
  evidence_field TEXT,                -- title | location | description
  policy_version TEXT NOT NULL DEFAULT 'v1',
  verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_verifications_posting ON verifications(posting_id);

CREATE TABLE IF NOT EXISTS reject_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id TEXT,
  company_id TEXT,
  reason TEXT NOT NULL,
  evidence TEXT,
  rejected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shard INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  companies_checked INTEGER DEFAULT 0,
  jobs_found INTEGER DEFAULT 0,
  jobs_accepted INTEGER DEFAULT 0,
  jobs_rejected INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  partial INTEGER DEFAULT 0           -- 1 = some fetch failed/partial: close NOTHING from this run
);

CREATE TABLE IF NOT EXISTS board_health (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  last_success TEXT,
  consecutive_empty INTEGER DEFAULT 0,
  needs_reresolve INTEGER DEFAULT 0
);
