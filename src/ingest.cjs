// ingest.cjs — the ingest pipeline: fetcher -> prefilter -> verifier -> db.
// Only verifier-accepted postings with verification_state='passed' ever
// reach the public query (enforced by db.listLiveJobs). Every reject is
// written to reject_log with reason + evidence span via db.ingestPosting.
// Company-level gate (ChatGPT): only scan US-verified companies. A company
// whose HQ is not US-verified is skipped entirely — its postings are never
// fetched. Pass { requireUsVerified: false } only for tests.
// Lifecycle: after a run, closeMissing() closes jobs absent from 2
// consecutive SUCCESSFUL fetches. A partial/errored run closes NOTHING.
'use strict';

const { verifyPosting } = require('./verifier.cjs');
const { upsertCompany, ingestPosting, closeMissing } = require('./db.cjs');
const { createCircuitBreaker, createRateLimiter } = require('./fetch-util.cjs');
const { fetchGreenhouseJobs } = require('./greenhouse.cjs');
const { fetchLeverJobs } = require('./lever.cjs');
const { fetchAshbyJobs } = require('./ashby.cjs');
const { fetchWorkdayJobs } = require('./workday.cjs');

const FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  workday: fetchWorkdayJobs,
};

// ATS API host per fetcher family. The rate limiter is keyed by HOST, not
// by company: two companies on boards-api.greenhouse.io share one limiter
// within this process/shard. A per-company limiter (the old code) let N
// companies on one host each run at 3 rps.
// HONEST LIMIT: this map is per-process only. Across 40 parallel Actions
// shards there is no shared state, so cross-shard per-host coordination is
// NOT possible in this design. Mitigations: the per-shard host limiter
// (this map), 429 Retry-After handling in fetchJsonWithRetry, and the
// per-company circuit breaker. Do not claim more than that.
const ATS_HOSTS = {
  greenhouse: 'boards-api.greenhouse.io',
  lever: 'api.lever.co',
  ashby: 'api.ashbyhq.com',
};
const hostLimiters = new Map();
function limiterForHost(host, maxRps = 3) {
  if (!hostLimiters.has(host)) hostLimiters.set(host, createRateLimiter(maxRps));
  return hostLimiters.get(host);
}
function resetHostLimiters() { hostLimiters.clear(); }

// Structured-flag prefilter. Only EXPLICIT non-remote flags reject here:
// workplaceType Hybrid/OnSite. 'Remote' and 'unspecified'/missing go to the
// full-text verifier — the flag is never proof of remote-ness, only a
// fail-closed reject when the ATS itself says the role is not remote.
// (Ashby isRemote is ignored entirely: it is true for Hybrid too.)
function prefilter(posting) {
  const wt = (posting.workplaceType || '').toLowerCase().replace(/[-\s]/g, '');
  if (wt === 'hybrid' || wt === 'onsite') {
    return {
      verdict: 'REJECT',
      reason: 'ats_workplace_not_remote',
      evidence: `ATS workplaceType=${posting.workplaceType}`,
      field: 'workplaceType',
    };
  }
  return null;
}

function toDbPosting(companyId, atsType, p) {
  return {
    companyId,
    atsType,
    atsJobId: p.ats_job_id,
    title: p.title,
    canonicalUrl: p.url,
    location: p.location_raw,
    description: p.description,
  };
}

// Ingest one company. `company` is the resolver record:
// { id, name, domain, careersUrl, atsType, atsSlug, atsHost, atsSite,
//   atsEvidenceUrl, hqCountry, usVerified, usEvidenceUrl, usVerifiedAt,
//   usExpiresAt }. `fetchFn` is injected (global fetch in Actions, canned
// in tests). Returns a run summary.
async function ingestCompany(db, company, fetchFn, opts = {}) {
  const atsType = (company.atsType || '').toLowerCase();
  const fetcher = FETCHERS[atsType];
  const summary = {
    companyId: company.id, atsType, fetched: 0, accepted: 0, rejected: 0,
    closed: 0, partial: false, skipped: null, errors: [], rejects: [],
  };
  if (!fetcher) {
    summary.skipped = `no_fetcher_for_${atsType || 'unresolved'}`;
    return summary;
  }
  if (opts.requireUsVerified !== false && !company.usVerified) {
    summary.skipped = 'company_not_us_verified';
    return summary;
  }
  // Round 9 (Mistral #6): HQ evidence expires after 180 days. build-
  // companies sets usVerified=false when it has expired — but if the
  // companies.json reaching ingest is STALE (built before the expiry),
  // usVerified is still true and ingest would happily re-verify the
  // company's jobs. Treat expired evidence as not verified, here in
  // ingestCompany, so the check holds on every path (ingest + reverify).
  if (company.usVerified && company.usExpiresAt
      && new Date(company.usExpiresAt).getTime() <= Date.now()) {
    summary.skipped = 'company_hq_evidence_expired';
    return summary;
  }
  if (!company.atsSlug) {
    summary.skipped = 'no_ats_slug';
    return summary;
  }

  upsertCompany(db, company);

  // Shared per-host limiter (see ATS_HOSTS above). opts.limiter still
  // overrides for tests. EU Lever uses its own host. Workday's host is
  // per-tenant (company.atsHost, e.g. acme.wd5.myworkdayjobs.com) — the
  // wd number comes from the resolver, never a wd5 default.
  const host = atsType === 'lever' && company.euLever ? 'api.eu.lever.co'
    : atsType === 'workday' ? (company.atsHost || null)
    : (ATS_HOSTS[atsType] || `${atsType}.example.invalid`);
  const limiter = opts.limiter || limiterForHost(host, opts.maxRps || 3);
  const breaker = opts.breaker || createCircuitBreaker();
  const fetchOpts = { limiter, maxRetries: opts.maxRetries, eu: !!company.euLever, host };
  let result;
  try {
    result = await breaker.call(() => fetcher(company.atsSlug, fetchFn, fetchOpts));
  } catch (err) {
    result = { postings: [], partial: true, errors: [{ error: `fetcher_threw: ${err.message}` }] };
  }
  if (!result || result.ok === false) {
    // Circuit open (or breaker-level failure): no data, run is partial.
    summary.partial = true;
    summary.errors.push({ error: (result && result.error) || 'circuit_open' });
    return summary;
  }
  summary.partial = !!result.partial;
  summary.errors = result.errors || [];
  if (summary.errors.length) summary.partial = true;

  const seenIds = new Set();
  for (const p of result.postings || []) {
    summary.fetched++;
    const dbPosting = toDbPosting(company.id, atsType, p);
    seenIds.add(dbPosting.companyId + '|' + dbPosting.atsType + '|' + dbPosting.atsJobId);
    const pre = prefilter(p);
    const verdict = pre || verifyPosting({
      title: p.title, location: p.location_raw, description: p.description, applyUrl: p.url,
    });
    const out = ingestPosting(db, dbPosting, verdict);
    if (verdict.verdict === 'ACCEPT') {
      summary.accepted++;
    } else {
      summary.rejected++;
      summary.rejects.push({ atsJobId: p.ats_job_id, title: p.title, reason: verdict.reason, evidence: verdict.evidence });
    }
    void out;
  }

  // Snapshot-diff closing: only from a complete, successful run.
  const close = closeMissing(db, company.id, seenIds, summary.partial);
  summary.closed = close.closed || 0;
  return summary;
}

// Run ingest across companies (one company at a time; Actions shards by
// company list). Returns per-company summaries + totals.
async function runIngest(db, companies, fetchFn, opts = {}) {
  const summaries = [];
  const totals = { fetched: 0, accepted: 0, rejected: 0, closed: 0, skipped: 0, partialRuns: 0, errors: 0 };
  for (const company of companies) {
    const s = await ingestCompany(db, company, fetchFn, opts);
    summaries.push(s);
    totals.fetched += s.fetched;
    totals.accepted += s.accepted;
    totals.rejected += s.rejected;
    totals.closed += s.closed;
    totals.errors += s.errors.length;
    if (s.skipped) totals.skipped++;
    if (s.partial) totals.partialRuns++;
  }
  return { summaries, totals };
}

module.exports = { ingestCompany, runIngest, prefilter, FETCHERS, limiterForHost, resetHostLimiters, ATS_HOSTS };
