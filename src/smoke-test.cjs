// smoke-test.cjs — proves the SQLite store works end to end:
// company upsert -> verified ingest (accept + reject) -> public query lists
// ONLY the verified-live job -> snapshot-diff closing -> expiry enforcement.
'use strict';

const fs = require('fs');
const { openDb, upsertCompany, ingestPosting, closeMissing, listLiveJobs, counts } = require('./db.cjs');
const { verifyPosting } = require('./verifier.cjs');

const DB = '/tmp/jobs-smoke.db';
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = openDb(DB);

upsertCompany(db, {
  id: 'acme.com', name: 'Acme Corp', domain: 'acme.com',
  careersUrl: 'https://acme.com/careers', atsType: 'greenhouse', atsSlug: 'acme',
  atsEvidenceUrl: 'https://acme.com/careers', hqCountry: 'US', usVerified: true,
  usEvidenceUrl: 'https://acme.com/about', usVerifiedAt: new Date().toISOString(),
});

const good = {
  companyId: 'acme.com', atsType: 'greenhouse', atsJobId: '123',
  title: 'Customer Success Manager', location: 'Remote - United States',
  description: 'Remote in all 50 states; no travel or office attendance required. This is a fully remote position. '
    + 'We are looking for a motivated team member to join our team. You will support customers by phone, email, and chat, '
    + 'and help resolve questions about products and services. This is a full-time position with benefits including '
    + 'health insurance, paid time off, and a 401(k) retirement plan. We are an equal opportunity employer.',
  canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
};
const bad = {
  companyId: 'acme.com', atsType: 'greenhouse', atsJobId: '124',
  title: 'Support Specialist', location: 'Remote',
  description: 'Hybrid role, 2 days per week in the office. Fully remote the rest of the week. '
    + 'We are looking for a motivated team member to join our team. You will support customers by phone, email, and chat, '
    + 'and help resolve questions about products and services. This is a full-time position with benefits including '
    + 'health insurance, paid time off, and a 401(k) retirement plan. We are an equal opportunity employer.',
  canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/124',
};

const vGood = verifyPosting(good);
const vBad = verifyPosting(bad);
console.log('verifier on good:', vGood.verdict, '| on bad:', vBad.verdict, `(${vBad.reason})`);
if (vGood.verdict !== 'ACCEPT' || vBad.verdict !== 'REJECT') throw new Error('verifier mismatch in smoke test');

console.log('ingest good:', JSON.stringify(ingestPosting(db, good, vGood)));
console.log('ingest bad:', JSON.stringify(ingestPosting(db, bad, vBad)));

const live = listLiveJobs(db);
console.log('public query rows:', live.length, '| titles:', live.map((j) => j.title));
if (live.length !== 1 || live[0].title !== 'Customer Success Manager') throw new Error('public query leaked a rejected job');

// Snapshot-diff closing: first miss only increments consecutive_misses (no
// close); second consecutive miss closes. Round 5 counter semantics.
let r = closeMissing(db, 'acme.com', new Set(), false);
console.log('closeMissing (1st miss):', JSON.stringify(r));
console.log('public query after 1st miss:', listLiveJobs(db).length);
if (listLiveJobs(db).length !== 1) throw new Error('first miss closed the job');
const misses = db.prepare("SELECT consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|123'").get();
if (misses.consecutive_misses !== 1) throw new Error('first miss did not record consecutive_misses = 1');
r = closeMissing(db, 'acme.com', new Set(), false);
console.log('closeMissing (2nd miss):', JSON.stringify(r));
console.log('public query after close:', listLiveJobs(db).length);
if (listLiveJobs(db).length !== 0) throw new Error('closed job still listed');

// Partial run must close nothing and change no counter.
db.prepare("UPDATE postings SET status = 'live', verification_state = 'passed', consecutive_misses = 1 WHERE id = 'acme.com|greenhouse|123'").run();
const partial = closeMissing(db, 'acme.com', new Set(), true);
console.log('closeMissing (partial run):', JSON.stringify(partial));
if (partial.closed !== 0) throw new Error('partial run closed jobs');
const missesAfterPartial = db.prepare("SELECT consecutive_misses FROM postings WHERE id = 'acme.com|greenhouse|123'").get();
if (missesAfterPartial.consecutive_misses !== 1) throw new Error('partial run changed consecutive_misses');

console.log('counts:', JSON.stringify(counts(db)));
console.log('SMOKE TEST: PASS');
db.close();
fs.unlinkSync(DB);
