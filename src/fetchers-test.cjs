// fetchers-test.cjs — end-to-end fetcher + ingest tests on CANNED data only.
// No live network. Exit 0 = gate passes. Exit 1 = gate fails.
// Gate: 0 false accepts AND 0 false rejects on the canned ATS payloads.
// Also covers: Greenhouse pagination (meta.next), 429 retry with
// Retry-After, per-company circuit breaker, non-US-verified company skip.
'use strict';

const fs = require('fs');
const { openDb, listLiveJobs, counts } = require('./db.cjs');
const { fetchGreenhouseJobs } = require('./greenhouse.cjs');
const { fetchLeverJobs } = require('./lever.cjs');
const { fetchAshbyJobs } = require('./ashby.cjs');
const { fetchWorkdayJobs, normalizeJob } = require('./workday.cjs');
const { runIngest } = require('./ingest.cjs');
const { createCircuitBreaker } = require('./fetch-util.cjs');

const gh = require('./testdata/greenhouse-acme.json');
const lever = require('./testdata/lever-globex.json');
const ashby = require('./testdata/ashby-initech.json');
const wd = require('./testdata/workday-acme.json');
const wdDetails = require('./testdata/workday-acme-details.json');

const DB = '/tmp/jobs-fetchers-test.db';
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = openDb(DB);

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// --- Canned fetch: routes by URL, supports scripted sequences ------------
// A route value may be a function (url, options) => step, for body-aware
// routing (Workday paginates by offset inside the POST body, same URL).
function makeCannedFetch(routes) {
  const calls = {};
  const fn = async (url, options) => {
    calls[url] = (calls[url] || 0) + 1;
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
    const step = typeof route === 'function'
      ? route(url, options || {})
      : (Array.isArray(route) ? route[Math.min(calls[url] - 1, route.length - 1)] : route);
    if (!step) return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? (step.retryAfter != null ? String(step.retryAfter) : null) : null) },
      text: async () => JSON.stringify(step.body),
    };
  };
  fn.calls = calls;
  return fn;
}

const GH_URL = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
const GH_URL2 = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&page=2';
const LV_URL = 'https://api.lever.co/v0/postings/globex?mode=json';
const AB_URL = 'https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true';

const WD_URL = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/ACME-Careers/jobs';

const fetchFn = makeCannedFetch({
  [GH_URL]: [{ status: 200, body: gh.page1 }],
  [GH_URL2]: [{ status: 200, body: gh.page2 }],
  // Lever: 429 first (Retry-After 0), then 200 — proves retry works.
  [LV_URL]: [
    { status: 429, retryAfter: 0, body: { error: 'rate limited' } },
    { status: 200, body: lever },
  ],
  [AB_URL]: [{ status: 200, body: ashby }],
  // Workday acme: list + the 2 detail GETs (shared with section 1a).
  [WD_URL]: [{ status: 200, body: wd }],
  ...wdDetails,
});

(async () => {
  // --- 1. Fetcher normalization + pagination ------------------------------
  const ghRes = await fetchGreenhouseJobs('acme', fetchFn);
  check('greenhouse: 3 postings across 2 pages (pagination followed)', ghRes.postings.length === 3 && ghRes.pages === 2, `got ${ghRes.postings.length} jobs, ${ghRes.pages} pages`);
  check('greenhouse: no partial', ghRes.partial === false);
  check('greenhouse: accept job normalized', ghRes.postings[0].ats_job_id === '101' && ghRes.postings[0].location_raw === 'Remote - United States');
  check('greenhouse: HTML stripped from description', !ghRes.postings[0].description.includes('<p>') && ghRes.postings[0].description.length > 400);

  const lvRes = await fetchLeverJobs('globex', fetchFn);
  check('lever: 3 postings after 429 retry', lvRes.postings.length === 3 && lvRes.partial === false, `calls to lever URL: ${fetchFn.calls[LV_URL]}`);
  check('lever: 429 was retried (2 calls)', fetchFn.calls[LV_URL] === 2);
  check('lever: no-location job has empty location_raw', lvRes.postings.find((p) => p.ats_job_id === 'lv-202').location_raw === '');

  const abRes = await fetchAshbyJobs('initech', fetchFn);
  check('ashby: 3 postings', abRes.postings.length === 3 && abRes.partial === false);
  check('ashby: isRemote NOT carried through (trap removed)', abRes.postings.every((p) => !('isRemote' in p)));
  check('ashby: hybrid job keeps workplaceType=Hybrid for prefilter', abRes.postings.find((p) => p.ats_job_id === 'ab-302').workplaceType === 'Hybrid');

  // --- 1a. Workday: POST pagination by offset, per-location dedupe --------
  // 22 listings: 20 on page 1 (offset 0), 1 new + 1 duplicate of R-2000 on
  // page 2 (offset 20). Unique postings must be 21, run NOT partial
  // (listed 22 == total 22 — dedupe must not inflate the shortfall).
  // Bigco externalPaths use the "/job/..." form (one of the two forms the
  // list API returns); acme uses the "/en-US/{site}/job/..." form. Both
  // must resolve to the same detail URL shape: BASE + "/job/" + rest.
  const WD_BIG_URL = 'https://bigco.wd1.myworkdayjobs.com/wday/cxs/bigco/BIGCO/jobs';
  const wdPage1Jobs = Array.from({ length: 20 }, (_, i) => ({
    title: `Job ${i}`,
    externalPath: `/job/City--ST/Job-${i}_R-20${String(i).padStart(2, '0')}`,
    locationsText: 'Remote - United States',
    postedOn: '2026-11-10',
    bulletFields: ['This is a fully remote position open to candidates anywhere in the United States.'],
  }));
  const wdPage2Jobs = [
    { title: 'Job 20', externalPath: '/job/City--ST/Job-20_R-2020', locationsText: 'Remote - United States', postedOn: '2026-11-10', bulletFields: ['Remote role.'] },
    { title: 'Job 0', externalPath: '/job/Other--ST/Job-0_R-2000', locationsText: 'Remote - United States', postedOn: '2026-11-10', bulletFields: ['Remote role.'] },
  ];
  // Detail route per unique bigco job (21): jobReqId is the last-segment
  // req; externalUrl is the public page URL (the /job/ form needs the
  // /en-US/{site} prefix added back).
  const wdBigDetails = {};
  for (const j of [...wdPage1Jobs, wdPage2Jobs[0]]) {
    const rest = j.externalPath.slice(j.externalPath.indexOf('/job/') + 5);
    const req = rest.split('/').pop().split('_').pop();
    wdBigDetails[`https://bigco.wd1.myworkdayjobs.com/wday/cxs/bigco/BIGCO/job/${rest}`] = {
      status: 200,
      body: { jobPostingInfo: { title: j.title, jobDescription: '<p>Remote role.</p>', location: 'Remote - United States', startDate: '2026-11-10', jobReqId: req, externalUrl: `https://bigco.wd1.myworkdayjobs.com/en-US/BIGCO/job/${rest}` } },
    };
  }
  const wdBodies = [];
  const wdFetch = makeCannedFetch({
    [WD_URL]: { status: 200, body: wd },
    ...wdDetails,
    ...wdBigDetails,
    [WD_BIG_URL]: (url, options) => {
      let offset = 0;
      try { const b = JSON.parse(options.body || '{}'); offset = b.offset || 0; wdBodies.push(b); } catch { offset = 0; }
      if (offset === 0) return { status: 200, body: { total: 22, jobPostings: wdPage1Jobs } };
      return { status: 200, body: { total: 22, jobPostings: wdPage2Jobs } };
    },
  });
  const wdRes = await fetchWorkdayJobs('acme/ACME-Careers', wdFetch, { host: 'acme.wd5.myworkdayjobs.com' });
  check('workday: 3 listings dedupe to 2 unique postings (same req, 2 locations)', wdRes.postings.length === 2, `got ${wdRes.postings.length}`);
  check('workday: no partial when listings == total', wdRes.partial === false, JSON.stringify(wdRes.errors));
  check('workday: ats_job_id prefers detail jobReqId', wdRes.postings.some((p) => p.ats_job_id === 'R-1001'));
  check('workday: description is the full detail jobDescription (>=400 chars)', wdRes.postings[0].description.includes('fully remote') && wdRes.postings[0].description.length >= 400, `len ${wdRes.postings[0].description.length}`);
  check('workday: url is the detail externalUrl', wdRes.postings[0].url === 'https://acme.wd5.myworkdayjobs.com/en-US/ACME-Careers/job/New-York--NY/Customer-Support-Specialist_R-1001');
  check('workday: posted_at prefers detail startDate', wdRes.postings[0].posted_at === '2026-11-10');
  const wdBig = await fetchWorkdayJobs('bigco/BIGCO', wdFetch, { host: 'bigco.wd1.myworkdayjobs.com' });
  check('workday: 22 listings across 2 pages -> 21 unique, 2 pages', wdBig.postings.length === 21 && wdBig.pages === 2, `got ${wdBig.postings.length} jobs, ${wdBig.pages} pages`);
  check('workday: paginated run not partial', wdBig.partial === false, JSON.stringify(wdBig.errors));
  check('workday: /job/ externalPath gets the /en-US/{site} prefix back', wdBig.postings[0].url === 'https://bigco.wd1.myworkdayjobs.com/en-US/BIGCO/job/City--ST/Job-0_R-2000', wdBig.postings[0].url);
  check('workday: POST bodies use limit 20 and offsets 0, 20', wdBodies.length === 2 && wdBodies.every((b) => b.limit === 20) && wdBodies[0].offset === 0 && wdBodies[1].offset === 20, JSON.stringify(wdBodies));
  // A detail 404 skips that posting (no thin-description insert) and
  // marks the run partial — the job stays live from the previous run.
  const wdNoDetail = makeCannedFetch({ [WD_URL]: { status: 200, body: wd } });
  const wdNoDetailRes = await fetchWorkdayJobs('acme/ACME-Careers', wdNoDetail, { host: 'acme.wd5.myworkdayjobs.com' });
  check('workday: failed detail fetch skips postings and marks partial', wdNoDetailRes.postings.length === 0 && wdNoDetailRes.partial === true, `got ${wdNoDetailRes.postings.length}, partial=${wdNoDetailRes.partial}`);
  // normalizeJob falls back to the last externalPath segment when the
  // detail response has no jobReqId.
  const wdFallback = normalizeJob('acme.wd5.myworkdayjobs.com', 'acme', 'ACME-Careers', wd.jobPostings[0], {});
  check('workday: no jobReqId falls back to last externalPath segment', wdFallback.ats_job_id === 'Customer-Support-Specialist_R-1001', wdFallback.ats_job_id);
  const wdNoHost = await fetchWorkdayJobs('acme/ACME-Careers', wdFetch, {});
  check('workday: missing host is an error, never a wd5 guess', wdNoHost.partial === true && wdNoHost.postings.length === 0 && wdNoHost.errors.some((e) => e.error === 'workday_host_missing'));
  const wdBadSlug = await fetchWorkdayJobs('acme', wdFetch, { host: 'acme.wd5.myworkdayjobs.com' });
  check('workday: malformed slug is an error', wdBadSlug.partial === true && wdBadSlug.errors.some((e) => e.error === 'workday_slug_malformed'));


  // --- 1b. Greenhouse meta.next to a foreign host is refused --------------
  // Round 5: meta.next used to be followed verbatim. A board pointing
  // pagination off-host must stop the fetcher, mark partial, and never
  // fetch the foreign URL.
  const evilFetch = makeCannedFetch({
    [GH_URL]: [{ status: 200, body: { ...gh.page1, meta: { next: 'https://evil.example.com/steal' } } }],
  });
  const evilRes = await fetchGreenhouseJobs('acme', evilFetch);
  check('greenhouse: off-host meta.next keeps page-1 postings', evilRes.postings.length === 1, `got ${evilRes.postings.length}`);
  check('greenhouse: off-host meta.next marks partial', evilRes.partial === true);
  check('greenhouse: off-host meta.next records next_url_unexpected_host', evilRes.errors.some((e) => e.error === 'next_url_unexpected_host'), JSON.stringify(evilRes.errors));
  check('greenhouse: off-host URL never fetched', !('https://evil.example.com/steal' in evilFetch.calls), JSON.stringify(Object.keys(evilFetch.calls)));

  // --- 2. Full ingest pipeline into the DB --------------------------------
  const companies = [
    { id: 'acme.com', name: 'Acme Corp', domain: 'acme.com', careersUrl: 'https://acme.com/careers', atsType: 'greenhouse', atsSlug: 'acme', atsEvidenceUrl: 'https://acme.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://acme.com/about', usVerifiedAt: new Date().toISOString() },
    { id: 'globex.com', name: 'Globex', domain: 'globex.com', careersUrl: 'https://globex.com/careers', atsType: 'lever', atsSlug: 'globex', atsEvidenceUrl: 'https://globex.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://globex.com/about', usVerifiedAt: new Date().toISOString() },
    { id: 'initech.com', name: 'Initech', domain: 'initech.com', careersUrl: 'https://initech.com/careers', atsType: 'ashby', atsSlug: 'initech', atsEvidenceUrl: 'https://initech.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://initech.com/about', usVerifiedAt: new Date().toISOString() },
    // Workday company (canned acme tenant): R-1001 ACCEPT, R-1002 REJECT.
    { id: 'wayne.com', name: 'Wayne Enterprises', domain: 'wayne.com', careersUrl: 'https://wayne.com/careers', atsType: 'workday', atsSlug: 'acme/ACME-Careers', atsHost: 'acme.wd5.myworkdayjobs.com', atsEvidenceUrl: 'https://wayne.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://wayne.com/about', usVerifiedAt: new Date().toISOString() },
  ];
  const { summaries, totals } = await runIngest(db, companies, fetchFn);
  console.log('ingest totals:', JSON.stringify(totals));
  for (const s of summaries) console.log(`  ${s.companyId}: fetched=${s.fetched} accepted=${s.accepted} rejected=${s.rejected} closed=${s.closed} partial=${s.partial} skipped=${s.skipped || '-'}`);

  check('ingest: 11 fetched total', totals.fetched === 11, `got ${totals.fetched}`);
  check('ingest: 4 accepted', totals.accepted === 4, `got ${totals.accepted}`);
  check('ingest: 7 rejected', totals.rejected === 7, `got ${totals.rejected}`);
  check('ingest: no partial runs', totals.partialRuns === 0);

  // Expected verdicts per job id.
  const expected = {
    'acme.com|greenhouse|101': 'ACCEPT',
    'acme.com|greenhouse|102': 'REJECT', // hybrid
    'acme.com|greenhouse|103': 'REJECT', // state-restricted
    'globex.com|lever|lv-201': 'ACCEPT',
    'globex.com|lever|lv-202': 'REJECT', // no location
    'globex.com|lever|lv-203': 'REJECT', // non-US (Canada)
    'initech.com|ashby|ab-301': 'ACCEPT',
    'initech.com|ashby|ab-302': 'REJECT', // Hybrid flag, isRemote=true trap
    'initech.com|ashby|ab-303': 'REJECT', // 25% travel
    'wayne.com|workday|R-1001': 'ACCEPT',
    'wayne.com|workday|R-1002': 'REJECT', // hybrid (3 days in Chicago office)
  };
  const rows = db.prepare('SELECT id, status, verification_state FROM postings').all();
  const live = listLiveJobs(db);
  let falseAccepts = 0;
  let falseRejects = 0;
  for (const [id, want] of Object.entries(expected)) {
    const row = rows.find((r) => r.id === id);
    const inPublic = live.some((j) => j.id === id);
    const got = inPublic ? 'ACCEPT' : 'REJECT';
    if (want === 'ACCEPT' && got !== 'ACCEPT') { falseRejects++; console.log(`  FALSE REJECT: ${id}`); }
    if (want === 'REJECT' && got !== 'REJECT') { falseAccepts++; console.log(`  FALSE ACCEPT: ${id} (status=${row && row.status}, state=${row && row.verification_state})`); }
  }
  check('gate: 0 false accepts on canned data', falseAccepts === 0, `${falseAccepts} false accepts`);
  check('gate: 0 false rejects on canned data', falseRejects === 0, `${falseRejects} false rejects`);
  check('public query lists exactly the 4 accepted jobs', live.length === 4, `got ${live.length}: ${live.map((j) => j.title).join(', ')}`);

  // Reject reasons recorded.
  const rejectReasons = db.prepare('SELECT reason, COUNT(*) c FROM reject_log GROUP BY reason').all();
  console.log('reject reasons:', JSON.stringify(rejectReasons));
  const reasons = Object.fromEntries(rejectReasons.map((r) => [r.reason, r.c]));
  check('reject log: hybrid recorded', reasons.hybrid === 2, JSON.stringify(reasons));
  check('reject log: state_restricted recorded', reasons.state_restricted === 1);
  check('reject log: blank_location recorded', reasons.blank_location === 1);
  check('reject log: non-US recorded', (reasons.remote_with_location || 0) + (reasons.non_us_location || 0) + (reasons.based_in_place || 0) === 1, JSON.stringify(reasons));
  check('reject log: ats_workplace_not_remote recorded (Ashby trap)', reasons.ats_workplace_not_remote === 1, JSON.stringify(reasons));
  check('reject log: travel_required recorded', reasons.travel_required === 1, JSON.stringify(reasons));
  check('reject log: 7 entries total', counts(db).rejected === 7, `got ${counts(db).rejected}`);

  // --- 3. Non-US-verified company is skipped entirely ----------------------
  const skipFetch = makeCannedFetch({});
  const { summaries: skipSum } = await runIngest(db, [
    { id: 'foreign.example', name: 'Foreign Co', domain: 'foreign.example', careersUrl: 'https://foreign.example/careers', atsType: 'greenhouse', atsSlug: 'foreign', hqCountry: 'DE', usVerified: false },
  ], skipFetch);
  check('non-US-verified company skipped, zero fetches', skipSum[0].skipped === 'company_not_us_verified' && Object.keys(skipFetch.calls).length === 0, JSON.stringify(skipSum[0]));

  // --- 4. Circuit breaker ---------------------------------------------------
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60000 });
  const failing = async () => ({ ok: false, error: 'http_500' });
  await breaker.call(failing);
  await breaker.call(failing);
  await breaker.call(failing);
  check('circuit breaker opens after 3 consecutive failures', breaker.state === 'open', `state=${breaker.state}`);
  let networkHit = false;
  const guarded = await breaker.call(async () => { networkHit = true; return { ok: true }; });
  check('open circuit blocks the call (no network hit)', guarded.error === 'circuit_open' && networkHit === false);

  // --- 5. Fetcher failure => partial run, closes nothing --------------------
  const failFetch = makeCannedFetch({
    [GH_URL]: [{ status: 500, body: { error: 'boom' } }],
  });
  const before = listLiveJobs(db).length;
  const { summaries: failSum } = await runIngest(db, [companies[0]], failFetch);
  check('failed fetch marks run partial', failSum[0].partial === true, JSON.stringify(failSum[0]));
  check('failed fetch closes nothing (live count unchanged)', listLiveJobs(db).length === before, `before=${before} after=${listLiveJobs(db).length}`);

  console.log(failures === 0 ? 'FETCHERS TEST: PASS' : `FETCHERS TEST: FAIL (${failures} failures)`);
  db.close();
  fs.unlinkSync(DB);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FETCHERS TEST: CRASH', err);
  try { db.close(); } catch {}
  try { fs.unlinkSync(DB); } catch {}
  process.exit(1);
});
