// ingest-run.cjs — CLI wrapper around runIngest, for GitHub Actions.
// Usage:
//   node src/ingest-run.cjs --companies data/companies.json --tier A \
//     --shard 0 --shards 40 --db data/shards/jobs-0.db \
//     --summary ingest-summary-0.json
//   --canned <file> : TEST ONLY. JSON {url: {status, body, retryAfter}} —
//     canned fetch, no network. Never pass it in Actions.
// Sharding: md5(company id) mod shards — deterministic as the roster grows,
// so adding companies never reshuffles existing assignments.
// Tier filter: only companies whose tier matches --tier (when given).
// Records a crawl_runs row. Exit 0 on a completed run EVEN IF partial —
// partial is recorded in the summary; the merge job warns on it but never
// fails the run (a partial run must not close jobs, and ingest.cjs already
// guarantees closeMissing() closes nothing from a partial run).
// NEVER run this with live fetch from the VM: employer-site fetches pop
// per-site approval cards. Live runs belong in Actions only.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { openDb } = require('./db.cjs');
const { runIngest } = require('./ingest.cjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}

function shardOf(id, shards) {
  const h = crypto.createHash('md5').update(String(id)).digest();
  return h.readUInt32BE(0) % shards;
}

// Canned fetch for local tests: same Response-like shape the fetchers expect.
function cannedFetch(map) {
  return async (url) => {
    const step = map[url];
    if (!step) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: {
        get: (h) => (h.toLowerCase() === 'retry-after'
          ? (step.retryAfter != null ? String(step.retryAfter) : null) : null),
      },
      text: async () => JSON.stringify(step.body),
    };
  };
}

async function main() {
  const a = parseArgs(process.argv);
  if (!a.companies || !a.db || !a.summary) {
    console.error('usage: node ingest-run.cjs --companies <file> --db <file> --summary <file> [--tier A|B] [--shard N --shards M] [--canned <file>]');
    process.exit(2);
  }
  const companies = JSON.parse(fs.readFileSync(a.companies, 'utf8'));
  const tier = a.tier || null;
  const shard = Number(a.shard || 0);
  const shards = Number(a.shards || 1);
  const mine = companies.filter((c) => {
    if (tier && c.tier !== tier) return false;
    return shardOf(c.id || c.domain, shards) === shard;
  });

  const db = openDb(a.db);
  const fetchFn = a.canned
    ? cannedFetch(JSON.parse(fs.readFileSync(a.canned, 'utf8')))
    : globalThis.fetch;
  const started = Date.now();
  const { summaries, totals } = await runIngest(db, mine, fetchFn, { maxRps: 3 });
  db.prepare(`INSERT INTO crawl_runs
    (shard, finished_at, companies_checked, jobs_found, jobs_accepted,
     jobs_rejected, errors, partial)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`)
    .run(shard, mine.length, totals.fetched, totals.accepted, totals.rejected,
      totals.errors, totals.partialRuns > 0 ? 1 : 0);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();

  const summary = {
    tier, shard, shards,
    companiesChecked: mine.length,
    totals,
    partial: totals.partialRuns > 0,
    summaries,
    ms: Date.now() - started,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(a.summary, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    tier, shard, checked: mine.length,
    fetched: totals.fetched, accepted: totals.accepted,
    rejected: totals.rejected, closed: totals.closed,
    skipped: totals.skipped, partialRuns: totals.partialRuns,
    errors: totals.errors, partial: summary.partial,
  }));
}

main().catch((e) => { console.error('INGEST-RUN: CRASH', e); process.exit(1); });
