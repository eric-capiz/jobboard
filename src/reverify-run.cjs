// reverify-run.cjs — liveness sweep + 14-day re-verify cycle.
// Usage:
//   node src/reverify-run.cjs --db data/jobs.db --mode liveness \
//     --out reverify-summary.json [--snapshot data/jobs.json]
//   node src/reverify-run.cjs --db data/jobs.db --mode reverify \
//     --companies data/companies.json --out reverify-summary.json \
//     [--snapshot data/jobs.json]
//   --url-status-file <file> : TEST ONLY. JSON {url: {status, finalUrl,
//     error}} — canned liveness answers, no network. Never in Actions.
//
// LIVENESS (daily): GET every live job's canonical_url.
//   200 + final URL on the same host ............ alive, untouched.
//   404 / 410 .................................. expired, closed_reason='liveness_404'.
//   Redirect to a DIFFERENT host, or landing on a generic careers/listing
//   page (/, /careers, /jobs) ................... expired, 'liveness_redirect'.
//   Same host, different specific path .......... alive (postings move).
//   Network error / timeout / 429 / 5xx / 403 ... UNTOUCHED, counted as
//   error. A failed fetch is never evidence of closure (Claude/Genspark).
//   Runs at 3 rps, 10s timeout, sequential — polite over fast.
// REVERIFY (~14 days, 1st + 15th): find companies owning live postings
//   whose verification_expires_at has passed, re-run ingest for exactly
//   those companies (global fetch, same verifier). ACCEPT refreshes the
//   14-day expiry; a complete run closes removed jobs via closeMissing;
//   a partial run closes nothing. Jobs already expired are hidden from
//   the public query by listLiveJobs regardless (verification_expires_at
//   > now is enforced in the query itself), so a missed reverify run
//   makes the board smaller, never stale (Perplexity).
// --snapshot rewrites jobs.json from listLiveJobs after either mode, so
// expired/hidden jobs leave the public snapshot the same day.
// Exit 0 on a completed sweep even with per-URL errors; exit 1 only on
// a crash (bad args, unreadable db).
'use strict';

const fs = require('fs');
const { openDb, listLiveJobs, counts } = require('./db.cjs');
const { runIngest } = require('./ingest.cjs');
const { createRateLimiter } = require('./fetch-util.cjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true; // boolean flag, e.g. --live
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const GENERIC_PATHS = new Set(['/', '/careers', '/careers/', '/jobs', '/jobs/']);

function isGenericLanding(originalUrl, finalUrl) {
  try {
    const o = new URL(originalUrl);
    const f = new URL(finalUrl);
    if (f.hostname !== o.hostname) return true; // different host = gone elsewhere
    if (f.pathname === o.pathname) return false; // same page
    return GENERIC_PATHS.has(f.pathname); // landed on a listing root
  } catch {
    return false;
  }
}

async function checkOne(url, fetchFn, limiter) {
  await limiter.wait();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JobBoard-Liveness/1.0 (+https://jobboard-rt89.onrender.com)' },
      redirect: 'follow',
    });
    const finalUrl = res.url || url;
    if (res.status === 404 || res.status === 410) return { outcome: 'expired', reason: 'liveness_404' };
    if (res.ok) {
      return isGenericLanding(url, finalUrl)
        ? { outcome: 'expired', reason: 'liveness_redirect' }
        : { outcome: 'alive' };
    }
    // 403 / 429 / 5xx / other: bot-block or outage — never evidence of closure.
    return { outcome: 'error', reason: `http_${res.status}` };
  } catch (e) {
    return { outcome: 'error', reason: `network: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function cannedLiveness(map) {
  return async (url) => {
    const step = map[url];
    if (!step) return { ok: false, status: 0, url, headers: { get: () => null } };
    if (step.error) throw new Error(step.error);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      url: step.finalUrl || url,
      headers: { get: () => null },
    };
  };
}

async function runLiveness(db, a) {
  const rows = db.prepare(
    "SELECT id, canonical_url FROM postings WHERE status = 'live'").all();
  const limiter = createRateLimiter(3);
  const fetchFn = a['url-status-file']
    ? cannedLiveness(JSON.parse(fs.readFileSync(a['url-status-file'], 'utf8')))
    : globalThis.fetch;
  const summary = { mode: 'liveness', checked: rows.length, alive: 0, expired: 0, errors: 0, details: [] };
  for (const row of rows) {
    const r = await checkOne(row.canonical_url, fetchFn, limiter);
    if (r.outcome === 'alive') {
      summary.alive++;
    } else if (r.outcome === 'expired') {
      db.prepare(`UPDATE postings SET status = 'expired', closed_reason = ?
        WHERE id = ?`).run(r.reason, row.id);
      summary.expired++;
      summary.details.push({ id: row.id, reason: r.reason });
    } else {
      summary.errors++;
      summary.details.push({ id: row.id, reason: r.reason });
    }
  }
  return summary;
}

// Round 9 (Mistral): reverify filtered companies only by "has expired
// postings" and never re-checked usVerified/usExpiresAt. If companies.json
// is stale (the 180-day HQ evidence expired but build-companies was not
// re-run), it happily re-extended 14-day verification on companies no
// longer on the valid allowlist. The HQ-expiry check now lives in two
// places: here (stale companies are filtered out of the reverify set
// and counted) and in ingestCompany (defense in depth — any stale
// companies.json reaching ingest is skipped there too).
function filterReverifyCompanies(all, companyIds) {
  const now = Date.now();
  const mine = [];
  let skippedHqExpired = 0;
  for (const c of all) {
    if (!companyIds.has(c.id || c.domain)) continue;
    if (c.usExpiresAt && new Date(c.usExpiresAt).getTime() <= now) {
      skippedHqExpired++;
      continue;
    }
    mine.push(c);
  }
  return { mine, skippedHqExpired };
}

async function runReverify(db, a) {
  if (!a.companies) {
    console.error('reverify mode needs --companies <file>');
    process.exit(2);
  }
  // datetime() wrap (round 9, Mistral #2): verification_expires_at may be
  // stored as ISO ("2026-12-02T18:04:11.000Z") by rows written before the
  // SQLite-format fix; a bare `<= datetime('now')` never matches ISO rows
  // ('T' > ' '), so expired postings were never selected for reverify.
  const rows = db.prepare(`SELECT DISTINCT company_id FROM postings
    WHERE status = 'live' AND datetime(verification_expires_at) <= datetime('now')`).all();
  const companyIds = new Set(rows.map((r) => r.company_id));
  const all = JSON.parse(fs.readFileSync(a.companies, 'utf8'));
  const { mine, skippedHqExpired } = filterReverifyCompanies(all, companyIds);
  const { summaries, totals } = await runIngest(db, mine, globalThis.fetch, { maxRps: 3 });
  return {
    mode: 'reverify',
    companiesWithExpired: companyIds.size,
    companiesReIngested: mine.length,
    companiesSkippedHqExpired: skippedHqExpired,
    totals,
    partial: totals.partialRuns > 0,
    summaries,
  };
}

async function main() {
  const a = parseArgs(process.argv);
  if (!a.db || !a.mode || !a.out) {
    console.error('usage: node reverify-run.cjs --db <file> --mode liveness|reverify --out <file> [--companies <file>] [--snapshot <file>] [--url-status-file <file>]');
    process.exit(2);
  }
  const db = openDb(a.db);
  let summary;
  if (a.mode === 'liveness') summary = await runLiveness(db, a);
  else if (a.mode === 'reverify') summary = await runReverify(db, a);
  else {
    console.error(`unknown mode: ${a.mode}`);
    process.exit(2);
  }
  summary.finishedAt = new Date().toISOString();
  summary.counts = counts(db);

  if (a.snapshot) {
    const jobs = listLiveJobs(db, 10000, 0);
    fs.writeFileSync(a.snapshot, JSON.stringify({
      generatedAt: new Date().toISOString(),
      counts: summary.counts,
      liveJobs: jobs.length,
      jobs,
    }, null, 2));
    summary.snapshot = a.snapshot;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();

  fs.writeFileSync(a.out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    mode: summary.mode,
    checked: summary.checked ?? summary.companiesReIngested,
    alive: summary.alive, expired: summary.expired,
    errors: summary.errors ?? summary.totals?.errors,
    liveJobs: summary.counts.live,
  }));
}

if (require.main === module) main().catch((e) => { console.error('REVERIFY-RUN: CRASH', e); process.exit(1); });

module.exports = { filterReverifyCompanies, runReverify, runLiveness, checkOne, isGenericLanding };
