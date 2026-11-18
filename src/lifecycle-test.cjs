// lifecycle-test.cjs — proves snapshot-diff closing, re-verify on content
// change, and expiry enforcement in the public query. Canned data only.
// Exit 0 = all pass.
'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, upsertCompany, ingestPosting, closeMissing, listLiveJobs, counts } = require('./db.cjs');
const { verifyPosting } = require('./verifier.cjs');
const { mergeDbs } = require('./merge-dbs.cjs');
const { ingestCompany } = require('./ingest.cjs');
const { filterReverifyCompanies } = require('./reverify-run.cjs');

const DB = '/tmp/jobs-lifecycle-test.db';
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = openDb(DB);

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

upsertCompany(db, {
  id: 'acme.com', name: 'Acme Corp', domain: 'acme.com',
  careersUrl: 'https://acme.com/careers', atsType: 'greenhouse', atsSlug: 'acme',
  atsEvidenceUrl: 'https://acme.com/careers', hqCountry: 'US', usVerified: true,
  usEvidenceUrl: 'https://acme.com/about', usVerifiedAt: new Date().toISOString(),
});

const FILLER = 'We are looking for a motivated team member to join our team. You will support customers by phone, email, and chat, and help resolve questions about products and services. This is a full-time position with benefits including health insurance, paid time off, and a 401(k) retirement plan. We are an equal opportunity employer and welcome applicants from all backgrounds. You will work with a friendly team and have clear goals and regular feedback. Strong written communication skills and attention to detail are important. Experience with customer support tools is helpful but not required. We provide training and the equipment you need to do the job well.';

function makeJob(id, descSuffix) {
  return {
    companyId: 'acme.com', atsType: 'greenhouse', atsJobId: id,
    title: 'Customer Success Manager', location: 'Remote - United States',
    description: 'This is a fully remote position. Work from anywhere in the United States — remote in all 50 states; no travel or office attendance required. ' + FILLER + (descSuffix || ''),
    canonicalUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  };
}

const jobA = makeJob('201');
const jobB = makeJob('202');
const vA = verifyPosting(jobA);
const vB = verifyPosting(jobB);
check('fixtures verify ACCEPT', vA.verdict === 'ACCEPT' && vB.verdict === 'ACCEPT');
ingestPosting(db, jobA, vA);
ingestPosting(db, jobB, vB);
check('2 jobs live in public query', listLiveJobs(db).length === 2);

// --- 1. First miss increments the counter but does NOT close ----------
// Round 5: persistent consecutive_misses counter replaces the last_seen
// > 24h age heuristic (which closed on the first miss for daily runs).
let r = closeMissing(db, 'acme.com', new Set(['acme.com|greenhouse|202']), false);
check('first miss closes nothing', r.closed === 0, JSON.stringify(r));
check('job A still live after first miss', listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|201'));
const miss1 = db.prepare("SELECT consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('first miss records consecutive_misses = 1', miss1.consecutive_misses === 1, JSON.stringify(miss1));

// --- 1b. A hit resets the counter -----------------------------------------
r = closeMissing(db, 'acme.com', new Set(['acme.com|greenhouse|201', 'acme.com|greenhouse|202']), false);
check('a hit closes nothing', r.closed === 0, JSON.stringify(r));
const miss0 = db.prepare("SELECT consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('a hit resets consecutive_misses to 0', miss0.consecutive_misses === 0, JSON.stringify(miss0));

// --- 2. Two consecutive misses close -------------------------------------
r = closeMissing(db, 'acme.com', new Set(['acme.com|greenhouse|202']), false);
check('first of two consecutive misses closes nothing', r.closed === 0, JSON.stringify(r));
r = closeMissing(db, 'acme.com', new Set(['acme.com|greenhouse|202']), false);
check('second consecutive miss closes the job', r.closed === 1, JSON.stringify(r));
check('closed job hidden from public query', listLiveJobs(db).length === 1 && listLiveJobs(db)[0].id === 'acme.com|greenhouse|202');
const closedRow = db.prepare("SELECT status, closed_reason, consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('closed row marked expired/removed_from_ats', closedRow.status === 'expired' && closedRow.closed_reason === 'removed_from_ats', JSON.stringify(closedRow));
check('closed job records consecutive_misses = 2', closedRow.consecutive_misses === 2, JSON.stringify(closedRow));

// --- 3. Partial/errored run closes NOTHING and changes no counter ---------
db.prepare("UPDATE postings SET status = 'live', verification_state = 'passed', consecutive_misses = 1 WHERE id = 'acme.com|greenhouse|201'").run();
r = closeMissing(db, 'acme.com', new Set(), true);
check('partial run closes nothing', r.closed === 0 && r.skippedPartial === true, JSON.stringify(r));
check('job still live after partial run', listLiveJobs(db).length === 2);
const missP = db.prepare("SELECT consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('partial run leaves consecutive_misses unchanged', missP.consecutive_misses === 1, JSON.stringify(missP));

// --- 4. Content-hash change triggers re-verify ------------------------------
const jobB2 = makeJob('202', ' Note: this role now includes a quarterly team gathering by video call.');
const vB2 = verifyPosting(jobB2);
check('changed description still verifies ACCEPT', vB2.verdict === 'ACCEPT', vB2.reason);
const out = ingestPosting(db, jobB2, vB2);
check('re-ingest of changed job returns updated', out.action === 'updated', JSON.stringify(out));
const versions = db.prepare("SELECT COUNT(*) c FROM posting_versions WHERE posting_id = 'acme.com|greenhouse|202'").get().c;
check('new content version stored (2 versions)', versions === 2, `got ${versions}`);
const verifs = db.prepare("SELECT COUNT(*) c FROM verifications WHERE posting_id = 'acme.com|greenhouse|202'").get().c;
check('second verification row recorded', verifs === 2, `got ${verifs}`);
const hashRow = db.prepare("SELECT content_hash FROM postings WHERE id = 'acme.com|greenhouse|202'").get();
const { contentHash } = require('./db.cjs');
check('stored content_hash matches new description', hashRow.content_hash === contentHash('acme.com', jobB2.title, jobB2.location, jobB2.canonicalUrl, jobB2.description));

// --- 6. Re-ingest of a returning job zeroes the stale miss counter --------
// Round 7 (Genspark re-vote): a job closed after 2 misses that re-appears
// at the ATS went live again via ingestPosting but kept consecutive_misses
// = 2. ingestPosting now zeroes the counter on re-ingest.
r = closeMissing(db, 'acme.com', new Set(['acme.com|greenhouse|202']), false);
check('one more miss closes job A (counter was already 1 from section 3)', r.closed === 1, JSON.stringify(r));
const closedAgain = db.prepare("SELECT status, consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('job A closed with consecutive_misses = 2', closedAgain.status === 'expired' && closedAgain.consecutive_misses === 2, JSON.stringify(closedAgain));
const vA2 = verifyPosting(jobA);
check('returning job A still verifies ACCEPT', vA2.verdict === 'ACCEPT', vA2.reason);
const reOut = ingestPosting(db, jobA, vA2);
check('re-ingest of returning job returns updated', reOut.action === 'updated', JSON.stringify(reOut));
const returned = db.prepare("SELECT status, consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|201'").get();
check('re-ingested job is live with consecutive_misses = 0', returned.status === 'live' && returned.consecutive_misses === 0, JSON.stringify(returned));
check('re-ingested job back in public query', listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|201'));

// --- 7. Expired verification hides the job (without deleting it) ------------
const expires = db.prepare("SELECT verification_expires_at FROM postings WHERE id = 'acme.com|greenhouse|202'").get().verification_expires_at;
const daysOut = (new Date(expires).getTime() - Date.now()) / 86400000;
check('verification expiry is ~14 days out (re-verify cycle)', daysOut > 13 && daysOut < 15, `${daysOut.toFixed(2)} days`);
db.prepare("UPDATE postings SET verification_expires_at = datetime('now', '-1 hour') WHERE id = 'acme.com|greenhouse|202'").run();
check('expired job hidden from public query', !listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|202'));
const stillThere = db.prepare("SELECT status FROM postings WHERE id = 'acme.com|greenhouse|202'").get();
check('expired job still in DB as live (hidden, not deleted)', stillThere.status === 'live');
db.prepare("UPDATE postings SET verification_expires_at = datetime('now', '+14 days') WHERE id = 'acme.com|greenhouse|202'").run();
check('re-verified job returns to public query', listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|202'));

// --- 8. ISO-format expiry is excluded too (Mistral #2, round 9) -------------
// Section 7 proved the SQLite-format expiry hides a job. The old code
// stored ISO ("2026-12-02T18:04:11.000Z") but compared to datetime('now')
// ("2026-12-02 18:04:11") — 'T' > ' ', so an ISO expiry earlier today
// stayed published for the rest of the UTC day. listLiveJobs now wraps
// the column in datetime(), which parses both formats.
const isoPast = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const isoFuture = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
db.prepare('UPDATE postings SET verification_expires_at = ? WHERE id = ?').run(isoPast, 'acme.com|greenhouse|202');
check('ISO expiry 2h ago hidden from public query', !listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|202'));
db.prepare('UPDATE postings SET verification_expires_at = ? WHERE id = ?').run(isoFuture, 'acme.com|greenhouse|202');
check('ISO expiry 2h ahead visible in public query', listLiveJobs(db).some((j) => j.id === 'acme.com|greenhouse|202'));
// New rows are stored in SQLite format (toSqliteTs).
const storedFmt = db.prepare("SELECT verification_expires_at FROM postings WHERE id = 'acme.com|greenhouse|201'").get().verification_expires_at;
check('stored expiry is SQLite format (no T, no Z)', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(storedFmt), storedFmt);

// --- 9. Merge keeps a missing shard's jobs (Mistral #1, round 9) -------------
// The old merge unlinked the canonical DB and rebuilt from this run's
// artifacts only — a failed shard's jobs vanished until the next fully
// successful run. The merge now upserts into the persisted canonical DB.
const MT = '/tmp/jobs-merge-lifecycle-test';
fs.rmSync(MT, { recursive: true, force: true });
function buildShard(dir, companyId, name, jobId) {
  fs.mkdirSync(dir, { recursive: true });
  const sdb = openDb(path.join(dir, 'jobs.db'));
  upsertCompany(sdb, {
    id: companyId, name, domain: companyId, careersUrl: `https://${companyId}/careers`,
    atsType: 'greenhouse', atsSlug: companyId.split('.')[0], atsEvidenceUrl: `https://${companyId}/careers`,
    hqCountry: 'US', usVerified: true, usEvidenceUrl: `https://${companyId}/about`,
    usVerifiedAt: new Date().toISOString(),
  });
  const job = makeJob(jobId);
  job.companyId = companyId;
  job.canonicalUrl = `https://boards.greenhouse.io/${companyId.split('.')[0]}/jobs/${jobId}`;
  const v = verifyPosting(job);
  if (v.verdict !== 'ACCEPT') throw new Error('merge fixture did not verify: ' + JSON.stringify(v));
  ingestPosting(sdb, job, v);
  sdb.close();
}
buildShard(MT + '/in/shard-a', 'acme.com', 'Acme Corp', '301');
buildShard(MT + '/in/shard-b', 'globex.com', 'Globex Inc', '401');
let mOut = mergeDbs({ inputs: MT + '/in', out: MT + '/canonical.db', snapshot: MT + '/canonical.json' });
check('merge of both shards: 2 live jobs', mOut.liveJobs === 2, JSON.stringify(mOut.liveJobs));
fs.rmSync(MT + '/in-only-a', { recursive: true, force: true });
fs.mkdirSync(MT + '/in-only-a', { recursive: true });
fs.cpSync(MT + '/in/shard-a', MT + '/in-only-a/shard-a', { recursive: true });
mOut = mergeDbs({ inputs: MT + '/in-only-a', out: MT + '/canonical.db', snapshot: MT + '/canonical.json' });
const snap9 = JSON.parse(fs.readFileSync(MT + '/canonical.json', 'utf8'));
check('missing shard B jobs SURVIVE second merge', snap9.jobs.some((j) => j.company_id === 'globex.com'), `liveJobs=${snap9.liveJobs}`);
const cdb = openDb(MT + '/canonical.db');
const vCountBefore = cdb.prepare('SELECT COUNT(*) c FROM verifications').get().c;
cdb.close();
mergeDbs({ inputs: MT + '/in', out: MT + '/canonical.db', snapshot: MT + '/canonical.json' });
const cdb2 = openDb(MT + '/canonical.db');
const vCountAfter = cdb2.prepare('SELECT COUNT(*) c FROM verifications').get().c;
cdb2.close();
check('re-merge does not duplicate verifications', vCountAfter === vCountBefore, `before=${vCountBefore} after=${vCountAfter}`);

// --- 10. Merge prunes log rows older than 30 days (Mistral re-vote, round 10) ---
// verifications + reject_log are append-only and Tier A re-appends ~48 rows
// per live job per day; the canonical DB is persisted + committed back every
// merge, so without a prune it grows without bound. Seed old (>30d) + recent
// rows, re-merge, prove old are gone and recent survive.
const cdb3 = openDb(MT + '/canonical.db');
for (let i = 0; i < 2; i++) {
  cdb3.prepare("INSERT INTO verifications (posting_id, verdict, reason, evidence, evidence_field, verified_at) VALUES ('acme.com|greenhouse|301', 'ACCEPT', 'ok', '', 'description', datetime('now','-40 days'))").run();
  cdb3.prepare("INSERT INTO reject_log (posting_id, company_id, reason, evidence, rejected_at) VALUES ('globex.com|greenhouse|401', 'globex.com', 'hybrid', '', datetime('now','-40 days'))").run();
}
cdb3.prepare("INSERT INTO verifications (posting_id, verdict, reason, evidence, evidence_field, verified_at) VALUES ('acme.com|greenhouse|301', 'ACCEPT', 'ok', '', 'description', datetime('now','-1 day'))").run();
cdb3.prepare("INSERT INTO reject_log (posting_id, company_id, reason, evidence, rejected_at) VALUES ('globex.com|greenhouse|401', 'globex.com', 'hybrid', '', datetime('now','-1 day'))").run();
const recentVBefore = cdb3.prepare("SELECT COUNT(*) c FROM verifications WHERE verified_at >= datetime('now','-30 days')").get().c;
const recentRBefore = cdb3.prepare("SELECT COUNT(*) c FROM reject_log WHERE rejected_at >= datetime('now','-30 days')").get().c;
cdb3.close();
const mPrune = mergeDbs({ inputs: MT + '/in', out: MT + '/canonical.db', snapshot: MT + '/canonical.json' });
check('merge reports 2 pruned verifications', mPrune.pruned && mPrune.pruned.verifications === 2, JSON.stringify(mPrune.pruned));
check('merge reports 2 pruned reject_log', mPrune.pruned && mPrune.pruned.rejectLog === 2, JSON.stringify(mPrune.pruned));
const cdb4 = openDb(MT + '/canonical.db');
const oldVAfter = cdb4.prepare("SELECT COUNT(*) c FROM verifications WHERE verified_at < datetime('now','-30 days')").get().c;
const oldRAfter = cdb4.prepare("SELECT COUNT(*) c FROM reject_log WHERE rejected_at < datetime('now','-30 days')").get().c;
const recentVAfter = cdb4.prepare("SELECT COUNT(*) c FROM verifications WHERE verified_at >= datetime('now','-30 days')").get().c;
const recentRAfter = cdb4.prepare("SELECT COUNT(*) c FROM reject_log WHERE rejected_at >= datetime('now','-30 days')").get().c;
cdb4.close();
check('old verifications pruned', oldVAfter === 0, `old=${oldVAfter}`);
check('old reject_log pruned', oldRAfter === 0, `old=${oldRAfter}`);
check('recent verifications survive prune', recentVAfter === recentVBefore, `before=${recentVBefore} after=${recentVAfter}`);
check('recent reject_log survives prune', recentRAfter === recentRBefore, `before=${recentRBefore} after=${recentRAfter}`);
fs.rmSync(MT, { recursive: true, force: true });

// --- 11. HQ-expiry skip (Mistral #6, round 9) — async -----------------------
(async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; throw new Error('must not fetch'); };
  const s = await ingestCompany(db, {
    id: 'stale.com', name: 'Stale Inc', domain: 'stale.com', careersUrl: 'https://stale.com/careers',
    atsType: 'greenhouse', atsSlug: 'stale', atsEvidenceUrl: 'https://stale.com/careers',
    hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://stale.com/about',
    usVerifiedAt: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
    usExpiresAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(), // expired 20 days ago
  }, fetchFn, {});
  check('expired HQ evidence skips ingest', s.skipped === 'company_hq_evidence_expired', `skipped=${s.skipped}`);
  check('expired HQ evidence never fetches', fetchCalled === false);

  const f = filterReverifyCompanies([
    { id: 'a.com', usExpiresAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'b.com', usExpiresAt: new Date(Date.now() + 86400000).toISOString() },
    { id: 'c.com' },
    { id: 'd.com', usExpiresAt: new Date(Date.now() - 86400000).toISOString() },
  ], new Set(['a.com', 'b.com', 'c.com']));
  check('reverify filter keeps unexpired + unset HQ evidence',
    f.mine.map((c) => c.id).join(',') === 'b.com,c.com', JSON.stringify(f.mine.map((c) => c.id)));
  check('reverify filter counts expired HQ evidence as skipped',
    f.skippedHqExpired === 1, `got ${f.skippedHqExpired}`);
  check('reverify filter ignores companies outside the expired set',
    f.mine.length === 2, `got ${f.mine.length}`);

  console.log('counts:', JSON.stringify(counts(db)));
  console.log(failures === 0 ? 'LIFECYCLE TEST: PASS' : `LIFECYCLE TEST: FAIL (${failures} failures)`);
  db.close();
  fs.unlinkSync(DB);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('LIFECYCLE TEST: CRASH', err);
  try { db.close(); } catch {}
  try { fs.unlinkSync(DB); } catch {}
  process.exit(1);
});
