// merge-dbs.cjs — merge per-shard SQLite files into the canonical jobs.db
// and write the public jobs.json snapshot. Runs in the ingest workflow's
// merge job ONLY (GitHub Actions).
//
// Round 9 (Mistral): the old code DELETED the canonical DB on every run
// (fs.unlinkSync(a.out)) and rebuilt it from scratch from this run's
// artifact files only — while the comment claimed "a shard that failed
// and contributed no db this run simply leaves its companies' rows as
// they were in the last merge — nothing is ever deleted by a merge."
// That was false: if any shard's upload/artifact failed, ALL of that
// shard's companies' postings vanished from jobs.db and jobs.json until
// the next fully successful run (the board flapped). The merge now
// ATTACH-and-upserts into the PERSISTED canonical DB (checked out from
// the repo by the merge job, committed back after): a missing shard's
// rows stay exactly as the last good merge left them, and a re-merge of
// the same artifacts is idempotent. The 14-day verification expiry in
// listLiveJobs still hides genuinely stale jobs from the public query,
// so a row that never gets refreshed again ages out of the snapshot on
// its own — the merge itself never deletes jobs. It DOES prune
// append-only log rows older than 30 days (round 10): verifications +
// reject_log grow without bound on Tier A's 30-minute cron, and the
// persisted canonical DB is committed back every merge, so the repo
// would bloat with binary diffs. 30 days of audit evidence is the
// tradeoff — long enough to diagnose a bad week of ingests, short
// enough to keep the canonical DB small.
// Tables with natural PKs (companies, postings, board_health) merge with
// INSERT OR REPLACE. posting_versions (PK posting_id+content_hash) uses
// INSERT OR IGNORE. Append-only log tables (verifications, reject_log,
// crawl_runs) have per-shard AUTOINCREMENT ids that collide across shards,
// so they are re-inserted WITHOUT id and get fresh canonical ids — with
// a NOT EXISTS guard on their natural key so a re-merge of the same
// artifacts does not duplicate them.
// Snapshot: listLiveJobs(db, 10000, 0) — the same public query Render
// serves. Only status='live' AND verification_state='passed' AND
// unexpired rows ever appear in it.
// Usage:
//   node src/merge-dbs.cjs --inputs <dir-with-shard-dbs> \
//     --out data/jobs.db --snapshot data/jobs.json
// --inputs is scanned RECURSIVELY for *.db files (download-artifact drops
// each shard artifact in its own subdir). A missing/failed shard is a
// warning, not an error: merge proceeds with the shards that exist.
'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, listLiveJobs, counts } = require('./db.cjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}

function findDbs(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findDbs(full));
    else if (entry.isFile() && entry.name.endsWith('.db')) found.push(full);
  }
  return found.sort();
}

function mergeDbs({ inputs, out, snapshot }) {
  const shardDbs = findDbs(inputs);
  if (shardDbs.length === 0) {
    throw new Error(`MERGE-DBS: no *.db files under ${inputs} — nothing to merge.`);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // No unlink: the canonical DB persists across runs. openDb creates it
  // (fresh schema + migrations) when it does not exist yet.
  const db = openDb(out);

  let merged = 0;
  for (const file of shardDbs) {
    const alias = `s${merged}`;
    db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS ${alias}`);
    db.exec(`INSERT OR REPLACE INTO companies SELECT * FROM ${alias}.companies`);
    db.exec(`INSERT OR REPLACE INTO postings SELECT * FROM ${alias}.postings`);
    db.exec(`INSERT OR REPLACE INTO board_health SELECT * FROM ${alias}.board_health`);
    db.exec(`INSERT OR IGNORE INTO posting_versions SELECT * FROM ${alias}.posting_versions`);
    // Log tables: re-insert without id, but skip rows already merged from
    // an earlier merge of the same artifacts (natural-key dedupe).
    db.exec(`INSERT INTO verifications
      (posting_id, verdict, reason, evidence, evidence_field, policy_version, verified_at)
      SELECT posting_id, verdict, reason, evidence, evidence_field, policy_version, verified_at
      FROM ${alias}.verifications AS v
      WHERE NOT EXISTS (SELECT 1 FROM main.verifications AS m
        WHERE m.posting_id = v.posting_id AND m.verified_at = v.verified_at
          AND m.verdict = v.verdict AND m.reason = v.reason)`);
    db.exec(`INSERT INTO reject_log (posting_id, company_id, reason, evidence, rejected_at)
      SELECT posting_id, company_id, reason, evidence, rejected_at
      FROM ${alias}.reject_log AS v
      WHERE NOT EXISTS (SELECT 1 FROM main.reject_log AS m
        WHERE m.posting_id = v.posting_id AND m.company_id = v.company_id
          AND m.reason = v.reason AND m.rejected_at = v.rejected_at)`);
    db.exec(`INSERT INTO crawl_runs
      (shard, started_at, finished_at, companies_checked, jobs_found,
       jobs_accepted, jobs_rejected, errors, partial)
      SELECT shard, started_at, finished_at, companies_checked, jobs_found,
       jobs_accepted, jobs_rejected, errors, partial
      FROM ${alias}.crawl_runs AS v
      WHERE NOT EXISTS (SELECT 1 FROM main.crawl_runs AS m
        WHERE m.shard = v.shard AND m.started_at = v.started_at)`);
    db.exec(`DETACH DATABASE ${alias}`);
    merged++;
    console.log(`merged ${path.basename(file)}`);
  }

  // Round 10 (Mistral re-vote): prune append-only log rows older than
  // 30 days. verifications + reject_log are re-appended on every run
  // (~48 rows per live job per day on Tier A) and the persisted canonical
  // DB is committed back each merge, so without this the DB grows without
  // bound. 30 days of audit evidence is the tradeoff: long enough to
  // diagnose a bad week of ingests, short enough to keep the DB small.
  // (crawl_runs is one row per shard per run and posting_versions is
  // bounded by content changes — neither needs pruning.)
  const prunedVerifications = db.prepare(
    "DELETE FROM verifications WHERE verified_at < datetime('now','-30 days')").run().changes;
  const prunedRejectLog = db.prepare(
    "DELETE FROM reject_log WHERE rejected_at < datetime('now','-30 days')").run().changes;
  if (prunedVerifications > 0 || prunedRejectLog > 0) {
    console.log(`pruned ${prunedVerifications} verifications + ${prunedRejectLog} reject_log rows older than 30 days`);
  }

  const jobs = listLiveJobs(db, 10000, 0);
  const c = counts(db);
  const snapshotDoc = {
    generatedAt: new Date().toISOString(),
    counts: c,
    liveJobs: jobs.length,
    jobs,
  };
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify(snapshotDoc, null, 2));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();

  return { shardDbs: merged, out, snapshot, counts: c, liveJobs: jobs.length,
    pruned: { verifications: prunedVerifications, rejectLog: prunedRejectLog } };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.inputs || !a.out || !a.snapshot) {
    console.error('usage: node merge-dbs.cjs --inputs <dir> --out <jobs.db> --snapshot <jobs.json>');
    process.exit(2);
  }
  let result;
  try {
    result = mergeDbs({ inputs: a.inputs, out: a.out, snapshot: a.snapshot });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { mergeDbs, findDbs };
