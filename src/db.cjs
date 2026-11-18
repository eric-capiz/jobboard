// db.cjs — SQLite-file store for the ingest pipeline.
// Zero dependencies (node:sqlite, built into Node 24). The Actions runner
// builds jobs.db from this module; Render serves it read-only.
// Public query enforces: status='live' AND verification_state='passed' AND
// verification not expired. Nothing unverified can ever be listed.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// node:sqlite is built into Node >= 22.5. All workflows pin Node 24
// (actions/setup-node@v4, node-version: 24) and package.json enforces
// engines node >=24 via .npmrc engine-strict. Fail fast with a clear
// message instead of a bare MODULE_NOT_FOUND if run on an older Node.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'node:sqlite requires Node >= 22.5 (workflows pin Node 24). Run with Node 24+.',
  );
}

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Timestamps stored in SQLite's own format ('YYYY-MM-DD HH:MM:SS').
// Round 9 (Mistral): verification_expires_at was stored as ISO
// ("2026-12-02T18:04:11.000Z") but compared to datetime('now')
// ("2026-12-02 18:04:11"). Lexicographically 'T' > ' ', so an expired
// job stayed published for the rest of its expiry UTC day. New values
// are stored in SQLite format, and every comparison wraps the column in
// datetime() so legacy ISO rows compare correctly too.
function toSqliteTs(d) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
}

// Content hash covers EVERYTHING the public query displays or the
// verifier depends on: title, location, canonical URL, and the first 500
// tokens of the description. A change to any of them changes the hash and
// therefore stores a new posting_versions row on re-ingest.
function contentHash(companyId, title, location, canonicalUrl, description) {
  const tokens = (description || '').split(/\s+/).slice(0, 500).join(' ');
  return crypto.createHash('sha256')
    .update(`${companyId}|${(title || '').toLowerCase().trim()}|${(location || '').toLowerCase().trim()}|${(canonicalUrl || '').toLowerCase().trim()}|${tokens}`)
    .digest('hex');
}

function structuralHash(companyId, title, location) {
  return crypto.createHash('sha256')
    .update(`${companyId}|${(title || '').toLowerCase().trim()}|${(location || '').toLowerCase().trim()}`)
    .digest('hex');
}

function openDb(file) {
  // The Actions shard runners check out a repo with no data/shards/ dir;
  // SQLite will not create parent directories, so create them here.
  // (Ingest pilot run #1: every shard crashed with "unable to open
  // database file" because data/shards/ did not exist yet.)
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Migration for DBs built before round 5 (column added then). Throws
  // "duplicate column name" when the schema already has it — swallowed.
  try { db.exec('ALTER TABLE postings ADD COLUMN consecutive_misses INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
  return db;
}

// Upsert a company record. Returns the company id.
function upsertCompany(db, c) {
  db.prepare(`INSERT INTO companies
    (id, name, domain, careers_url, ats_type, ats_slug, ats_host, ats_site,
     ats_evidence_url, hq_country, us_verified, us_evidence_url, us_verified_at, us_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, careers_url = excluded.careers_url,
      ats_type = excluded.ats_type, ats_slug = excluded.ats_slug,
      ats_host = excluded.ats_host, ats_site = excluded.ats_site,
      ats_evidence_url = excluded.ats_evidence_url,
      hq_country = excluded.hq_country, us_verified = excluded.us_verified,
      us_evidence_url = excluded.us_evidence_url,
      us_verified_at = excluded.us_verified_at, us_expires_at = excluded.us_expires_at`)
    .run(
      c.id, c.name || null, c.domain, c.careersUrl || null,
      c.atsType || 'unresolved', c.atsSlug || null, c.atsHost || null, c.atsSite || null,
      c.atsEvidenceUrl || null, c.hqCountry || null, c.usVerified ? 1 : 0,
      c.usEvidenceUrl || null, c.usVerifiedAt || null, c.usExpiresAt || null,
    );
  return c.id;
}

// Insert or update a posting from a fetch + verifier verdict.
// Dedupe: (company_id, ats_type, ats_job_id) is the PK; a structural-hash
// collision with a different ATS id is logged, not merged (Perplexity:
// similarity is a duplicate CANDIDATE, not an automatic merge).
// Returns { action: 'inserted' | 'updated' | 'duplicate' | 'rejected', id }.
function ingestPosting(db, posting, verdict) {
  const id = `${posting.companyId}|${posting.atsType}|${posting.atsJobId}`;
  const ch = contentHash(posting.companyId, posting.title, posting.location, posting.canonicalUrl, posting.description);
  const sh = structuralHash(posting.companyId, posting.title, posting.location);
  const existing = db.prepare('SELECT id, content_hash, status FROM postings WHERE id = ?').get(id);

  if (verdict.verdict === 'REJECT') {
    db.prepare(`INSERT INTO reject_log (posting_id, company_id, reason, evidence)
      VALUES (?, ?, ?, ?)`).run(id, posting.companyId, verdict.reason, verdict.evidence || null);
    if (existing) {
      db.prepare(`UPDATE postings SET status = 'rejected', verification_state = 'failed',
        last_verified_at = datetime('now') WHERE id = ?`).run(id);
    }
    return { action: 'rejected', id };
  }

  // ACCEPT path: store excerpt + full version, mark live + passed.
  const excerpt = (posting.description || '').slice(0, 12000);
  const expiresAt = toSqliteTs(Date.now() + 14 * 24 * 3600 * 1000); // 14-day re-verify cycle
  if (!existing) {
    const dup = db.prepare(`SELECT id FROM postings
      WHERE structural_hash = ? AND id != ? AND status = 'live'`).get(sh, id);
    db.prepare(`INSERT INTO postings
      (id, company_id, ats_type, ats_job_id, title, canonical_url, location,
       description_excerpt, content_hash, structural_hash, status, verification_state,
       last_verified_at, verification_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'passed', datetime('now'), ?)`)
      .run(id, posting.companyId, posting.atsType, posting.atsJobId, posting.title,
        posting.canonicalUrl, posting.location || null, excerpt, ch, sh, expiresAt);
    db.prepare(`INSERT OR IGNORE INTO posting_versions (posting_id, content_hash, description)
      VALUES (?, ?, ?)`).run(id, ch, posting.description);
    db.prepare(`INSERT INTO verifications (posting_id, verdict, reason, evidence, evidence_field)
      VALUES (?, 'ACCEPT', 'passed', ?, ?)`).run(id, verdict.evidence || null, verdict.field || 'description');
    return { action: dup ? 'inserted-duplicate-noted' : 'inserted', id, structuralDuplicateOf: dup ? dup.id : null };
  }

  // Existing row: refresh ALL normalized fields atomically on re-verify, not
  // just timestamps. A changed title/location/URL must be what the public
  // query returns — never a stale value from the first ingest. The content
  // hash now covers title+location+URL, so any change to them stores a new
  // posting_versions row below.
  db.prepare(`UPDATE postings SET last_seen = datetime('now'),
    last_verified_at = datetime('now'), verification_expires_at = ?,
    status = 'live', verification_state = 'passed',
    consecutive_misses = 0,
    title = ?, canonical_url = ?, location = ?, structural_hash = ?,
    content_hash = ?, description_excerpt = ? WHERE id = ?`)
    .run(expiresAt, posting.title, posting.canonicalUrl, posting.location || null, sh, ch, excerpt, id);
  if (existing.content_hash !== ch) {
    db.prepare(`INSERT OR IGNORE INTO posting_versions (posting_id, content_hash, description)
      VALUES (?, ?, ?)`).run(id, ch, posting.description);
  }
  db.prepare(`INSERT INTO verifications (posting_id, verdict, reason, evidence, evidence_field)
    VALUES (?, 'ACCEPT', 'passed', ?, ?)`).run(id, verdict.evidence || null, verdict.field || 'description');
  return { action: 'updated', id };
}

// Snapshot-diff closing (Claude/Genspark): a job missing from 2 consecutive
// SUCCESSFUL fetches is closed. Never close from a partial/errored run.
// Round 5 (Genspark): the old last_seen > 24h age heuristic did NOT
// implement "2 consecutive misses" — for daily Tier B the first miss closed
// (last_seen was already ~24h old), and for 30-min Tier A a removed job
// stayed live ~24h. The counter is persistent per posting: +1 on a miss in
// a successful run, reset to 0 on a hit, close at 2. Partial runs touch
// nothing (early return above).
function closeMissing(db, companyId, seenIds, runWasPartial) {
  if (runWasPartial) return { closed: 0, skippedPartial: true };
  const live = db.prepare(`SELECT id, consecutive_misses FROM postings
    WHERE company_id = ? AND status = 'live'`).all(companyId);
  let closed = 0;
  for (const row of live) {
    if (seenIds.has(row.id)) {
      if (row.consecutive_misses > 0) {
        db.prepare('UPDATE postings SET consecutive_misses = 0 WHERE id = ?').run(row.id);
      }
      continue;
    }
    const misses = (row.consecutive_misses || 0) + 1;
    if (misses >= 2) {
      db.prepare(`UPDATE postings SET status = 'expired', closed_reason = 'removed_from_ats',
        consecutive_misses = ? WHERE id = ?`).run(misses, row.id);
      closed++;
    } else {
      db.prepare('UPDATE postings SET consecutive_misses = ? WHERE id = ?').run(misses, row.id);
    }
  }
  return { closed, skippedPartial: false };
}

// THE public query. Only verified-live, unexpired jobs. Render uses this.
function listLiveJobs(db, limit = 100, offset = 0) {
  return db.prepare(`SELECT p.id, p.company_id, p.title, p.canonical_url, p.location,
      p.description_excerpt, p.first_seen, p.last_verified_at
    FROM postings p
    WHERE p.status = 'live'
      AND p.verification_state = 'passed'
      AND datetime(p.verification_expires_at) > datetime('now')
    ORDER BY p.first_seen DESC LIMIT ? OFFSET ?`).all(limit, offset);
}

function counts(db) {
  return {
    companies: db.prepare('SELECT COUNT(*) c FROM companies').get().c,
    live: db.prepare("SELECT COUNT(*) c FROM postings WHERE status = 'live'").get().c,
    rejected: db.prepare('SELECT COUNT(*) c FROM reject_log').get().c,
    verifications: db.prepare('SELECT COUNT(*) c FROM verifications').get().c,
  };
}

module.exports = { openDb, upsertCompany, ingestPosting, closeMissing, listLiveJobs, counts, contentHash, structuralHash, toSqliteTs };
