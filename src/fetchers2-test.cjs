// fetchers2-test.cjs — tests for the second-wave fetchers (smartrecruiters,
// recruitee, personio) on CANNED data only. No live network.
// Exit 0 = gate passes. Exit 1 = gate fails.
// Same conventions as fetchers-test.cjs: canned fetch routed by URL,
// ingest end-to-end into a throwaway DB, gate 0 false accepts AND
// 0 false rejects.
// NOTE: icims + taleo have NO public JSON endpoint (verified live
// 2026-11-19) — they are HTML-tier only and have no fetcher here.
'use strict';

const fs = require('fs');
const { openDb, listLiveJobs, counts } = require('./db.cjs');
const { fetchSmartRecruitersJobs } = require('./smartrecruiters.cjs');
const { fetchRecruiteeJobs, parsePublishedAt } = require('./recruitee.cjs');
const { fetchPersonioJobs, parseFeed, feedUrls } = require('./personio.cjs');
const { runIngest } = require('./ingest.cjs');

const sr = require('./testdata/smartrecruiters-acme.json');
const rc = require('./testdata/recruitee-acme.json');
const personioXml = fs.readFileSync(`${__dirname}/testdata/personio-acme.xml`, 'utf8');

const DB = '/tmp/jobs-fetchers2-test.db';
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = openDb(DB);

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// --- Canned fetch: routes by URL, supports scripted sequences ------------
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
      // String bodies (XML feeds) pass through verbatim; objects are JSON.
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

// Shared ingest-gate check for the per-fetcher sections: returns
// { falseAccepts, falseRejects } and logs any mismatch.
function gateCheck(dbConn, expected) {
  const rows = dbConn.prepare('SELECT id, status, verification_state FROM postings').all();
  const live = listLiveJobs(dbConn);
  let falseAccepts = 0;
  let falseRejects = 0;
  for (const [id, want] of Object.entries(expected)) {
    const row = rows.find((r) => r.id === id);
    const inPublic = live.some((j) => j.id === id);
    const got = inPublic ? 'ACCEPT' : 'REJECT';
    if (want === 'ACCEPT' && got !== 'ACCEPT') { falseRejects++; console.log(`  FALSE REJECT: ${id}`); }
    if (want === 'REJECT' && got !== 'REJECT') { falseAccepts++; console.log(`  FALSE ACCEPT: ${id} (status=${row && row.status}, state=${row && row.verification_state})`); }
  }
  return { falseAccepts, falseRejects, live };
}

const SR_LIST = 'https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=0';
const SR_D1 = 'https://api.smartrecruiters.com/v1/companies/Acme/postings/sr-101';
const SR_D2 = 'https://api.smartrecruiters.com/v1/companies/Acme/postings/sr-102';
const SR_D3 = 'https://api.smartrecruiters.com/v1/companies/Acme/postings/sr-103';

const srFetch = makeCannedFetch({
  [SR_LIST]: [{ status: 200, body: sr.list }],
  [SR_D1]: [{ status: 200, body: sr.details['sr-101'] }],
  [SR_D2]: [{ status: 200, body: sr.details['sr-102'] }],
  [SR_D3]: [{ status: 200, body: sr.details['sr-103'] }],
});

(async () => {
  // --- SmartRecruiters: normalization + detail GETs -----------------------
  const srRes = await fetchSmartRecruitersJobs('Acme', srFetch);
  check('smartrecruiters: 3 postings, 1 list page + 3 detail GETs', srRes.postings.length === 3 && srRes.pages === 1, `got ${srRes.postings.length} jobs, ${srRes.pages} pages`);
  check('smartrecruiters: no partial', srRes.partial === false, JSON.stringify(srRes.errors));
  const sr101 = srRes.postings.find((p) => p.ats_job_id === 'sr-101');
  check('smartrecruiters: description is all 4 sections concatenated (>=400 chars)', sr101.description.length >= 400 && sr101.description.includes('fully remote') && sr101.description.includes('equal opportunity'), `len ${sr101.description.length}`);
  check('smartrecruiters: remote location derives workplaceType=remote', sr101.workplaceType === 'remote');
  check('smartrecruiters: url is the detail postingUrl', sr101.url === 'https://jobs.smartrecruiters.com/Acme/sr-101-customer-success-manager-');
  check('smartrecruiters: title trimmed', sr101.title === 'Customer Success Manager');
  const sr102 = srRes.postings.find((p) => p.ats_job_id === 'sr-102');
  check('smartrecruiters: hybrid location derives workplaceType=Hybrid for prefilter', sr102.workplaceType === 'Hybrid');
  const sr103 = srRes.postings.find((p) => p.ats_job_id === 'sr-103');
  check('smartrecruiters: onsite job keeps null workplaceType (verifier decides)', sr103.workplaceType === null && sr103.location_raw === 'Dallas, Texas, United States');

  // --- SmartRecruiters: pagination past the silent 100 cap ----------------
  // totalFound 250: 3 list pages (100/100/50), one detail GET per posting.
  const bigItems = (start, n) => Array.from({ length: n }, (_, i) => ({
    id: `big-${start + i}`,
    name: `Job ${start + i}`,
    releasedDate: '2026-11-10T00:00:00.000Z',
    location: { city: '', country: 'us', fullLocation: 'Remote - United States', hybrid: false, region: '', remote: true },
    ref: `https://api.smartrecruiters.com/v1/companies/BigCo/postings/big-${start + i}`,
  }));
  const bigDetails = {};
  for (let i = 0; i < 250; i++) {
    bigDetails[`https://api.smartrecruiters.com/v1/companies/BigCo/postings/big-${i}`] = {
      status: 200,
      body: { id: `big-${i}`, name: `Job ${i}`, postingUrl: `https://jobs.smartrecruiters.com/BigCo/big-${i}-job-${i}-`, releasedDate: '2026-11-10T00:00:00.000Z', location: { city: '', country: 'us', fullLocation: 'Remote - United States', hybrid: false, region: '', remote: true }, jobAd: { sections: { jobDescription: { text: '<p>Remote role.</p>' } } } },
    };
  }
  const bigFetch = makeCannedFetch({
    'https://api.smartrecruiters.com/v1/companies/BigCo/postings?limit=100&offset=0': (url) => ({ status: 200, body: { totalFound: 250, offset: 0, limit: 100, content: bigItems(0, 100) } }),
    'https://api.smartrecruiters.com/v1/companies/BigCo/postings?limit=100&offset=100': (url) => ({ status: 200, body: { totalFound: 250, offset: 100, limit: 100, content: bigItems(100, 100) } }),
    'https://api.smartrecruiters.com/v1/companies/BigCo/postings?limit=100&offset=200': (url) => ({ status: 200, body: { totalFound: 250, offset: 200, limit: 100, content: bigItems(200, 50) } }),
    ...bigDetails,
  });
  const bigRes = await fetchSmartRecruitersJobs('BigCo', bigFetch, { maxRps: 1000 }); // canned: no real rate limit to respect
  check('smartrecruiters: 250 postings across 3 pages (offset paging)', bigRes.postings.length === 250 && bigRes.pages === 3, `got ${bigRes.postings.length} jobs, ${bigRes.pages} pages`);
  check('smartrecruiters: paginated run not partial', bigRes.partial === false, JSON.stringify(bigRes.errors));

  // --- SmartRecruiters: unknown slug (200 + totalFound 0) is empty, not an error
  const emptyFetch = makeCannedFetch({
    'https://api.smartrecruiters.com/v1/companies/NoSuchCo/postings?limit=100&offset=0': [{ status: 200, body: { totalFound: 0, offset: 0, limit: 100, content: [] } }],
  });
  const emptyRes = await fetchSmartRecruitersJobs('NoSuchCo', emptyFetch);
  check('smartrecruiters: unknown slug returns 0 postings, not partial', emptyRes.postings.length === 0 && emptyRes.partial === false && emptyRes.pages === 1, JSON.stringify(emptyRes));

  // --- SmartRecruiters: failed detail fetch skips + marks partial ---------
  const noDetailFetch = makeCannedFetch({
    [SR_LIST]: [{ status: 200, body: sr.list }],
  });
  const noDetailRes = await fetchSmartRecruitersJobs('Acme', noDetailFetch);
  check('smartrecruiters: failed detail fetch skips postings and marks partial', noDetailRes.postings.length === 0 && noDetailRes.partial === true, `got ${noDetailRes.postings.length}, partial=${noDetailRes.partial}`);

  // --- SmartRecruiters: ingest end-to-end ---------------------------------
  const companies = [
    { id: 'acme-sr.com', name: 'Acme SR', domain: 'acme-sr.com', careersUrl: 'https://acme-sr.com/careers', atsType: 'smartrecruiters', atsSlug: 'Acme', atsEvidenceUrl: 'https://acme-sr.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://acme-sr.com/about', usVerifiedAt: new Date().toISOString() },
  ];
  const { summaries, totals } = await runIngest(db, companies, srFetch);
  console.log('ingest totals:', JSON.stringify(totals));
  for (const s of summaries) console.log(`  ${s.companyId}: fetched=${s.fetched} accepted=${s.accepted} rejected=${s.rejected} closed=${s.closed} partial=${s.partial} skipped=${s.skipped || '-'}`);
  check('ingest: 3 fetched, 1 accepted, 2 rejected', totals.fetched === 3 && totals.accepted === 1 && totals.rejected === 2, JSON.stringify(totals));
  check('ingest: no partial runs', totals.partialRuns === 0);

  const expected = {
    'acme-sr.com|smartrecruiters|sr-101': 'ACCEPT',
    'acme-sr.com|smartrecruiters|sr-102': 'REJECT', // Hybrid flag
    'acme-sr.com|smartrecruiters|sr-103': 'REJECT', // onsite Dallas office
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
  check('public query lists exactly the 1 accepted job', live.length === 1, `got ${live.length}: ${live.map((j) => j.title).join(', ')}`);
  check('reject log: 2 entries total', counts(db).rejected === 2, `got ${counts(db).rejected}`);

  // --- Recruitee: normalization (full description in list, no detail) -----
  const RC_URL = 'https://acme.recruitee.com/api/offers/';
  const rcFetch = makeCannedFetch({
    [RC_URL]: [{ status: 200, body: { offers: rc.offers } }],
  });
  const rcRes = await fetchRecruiteeJobs('acme', rcFetch);
  check('recruitee: 3 postings, 1 page, no detail GETs', rcRes.postings.length === 3 && rcRes.pages === 1, `got ${rcRes.postings.length} jobs, ${rcRes.pages} pages`);
  check('recruitee: no partial', rcRes.partial === false, JSON.stringify(rcRes.errors));
  const rc1 = rcRes.postings.find((p) => p.ats_job_id === '1001');
  check('recruitee: description is description + requirements (>=400 chars)', rc1.description.length >= 400 && rc1.description.includes('fully remote'), `len ${rc1.description.length}`);
  check('recruitee: remote flag derives workplaceType=remote', rc1.workplaceType === 'remote');
  check('recruitee: published_at parsed to ISO', rc1.posted_at === '2026-11-16T10:00:00Z', rc1.posted_at);
  check('recruitee: url is careers_url', rc1.url === 'https://acme.recruitee.com/o/customer-success-manager');
  const rc2 = rcRes.postings.find((p) => p.ats_job_id === '1002');
  check('recruitee: hybrid flag derives workplaceType=Hybrid for prefilter', rc2.workplaceType === 'Hybrid');
  const rc3 = rcRes.postings.find((p) => p.ats_job_id === '1003');
  check('recruitee: on_site flag derives workplaceType=Onsite', rc3.workplaceType === 'Onsite' && rc3.location_raw === 'Dallas, Texas, United States');
  check('recruitee: parsePublishedAt passes through unparseable dates', parsePublishedAt('not a date') === 'not a date' && parsePublishedAt(null) === null);

  // --- Recruitee: defensive meta.next loop + off-host guard ----------------
  const rcNextFetch = makeCannedFetch({
    [RC_URL]: [{ status: 200, body: { offers: [rc.offers[0]], meta: { next: 'https://acme.recruitee.com/api/offers/?cursor=2' } } }],
    'https://acme.recruitee.com/api/offers/?cursor=2': [{ status: 200, body: { offers: [rc.offers[1]] } }],
  });
  const rcNextRes = await fetchRecruiteeJobs('acme', rcNextFetch);
  check('recruitee: meta.next followed (2 pages, 2 postings)', rcNextRes.postings.length === 2 && rcNextRes.pages === 2, `got ${rcNextRes.postings.length}, pages=${rcNextRes.pages}`);
  const rcEvilFetch = makeCannedFetch({
    [RC_URL]: [{ status: 200, body: { offers: [rc.offers[0]], meta: { next: 'https://evil.example.com/steal' } } }],
  });
  const rcEvilRes = await fetchRecruiteeJobs('acme', rcEvilFetch);
  check('recruitee: off-host meta.next keeps page-1 postings', rcEvilRes.postings.length === 1, `got ${rcEvilRes.postings.length}`);
  check('recruitee: off-host meta.next marks partial', rcEvilRes.partial === true);
  check('recruitee: off-host URL never fetched', !('https://evil.example.com/steal' in rcEvilFetch.calls));

  // --- Recruitee: unknown slug 404 => partial, no postings -----------------
  const rc404Fetch = makeCannedFetch({
    [RC_URL]: [{ status: 404, body: { error: 'not found' } }],
  });
  const rc404Res = await fetchRecruiteeJobs('acme', rc404Fetch);
  check('recruitee: unknown slug 404 is partial with 0 postings', rc404Res.postings.length === 0 && rc404Res.partial === true, JSON.stringify(rc404Res.errors));

  // --- Recruitee: ingest end-to-end (own DB) -------------------------------
  const DB_RC = '/tmp/jobs-fetchers2-recruitee-test.db';
  if (fs.existsSync(DB_RC)) fs.unlinkSync(DB_RC);
  const dbRc = openDb(DB_RC);
  const { summaries: rcSum, totals: rcTot } = await runIngest(dbRc, [
    { id: 'acme-rc.com', name: 'Acme RC', domain: 'acme-rc.com', careersUrl: 'https://acme-rc.com/careers', atsType: 'recruitee', atsSlug: 'acme', atsEvidenceUrl: 'https://acme-rc.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://acme-rc.com/about', usVerifiedAt: new Date().toISOString() },
  ], rcFetch);
  check('recruitee ingest: 3 fetched, 1 accepted, 2 rejected', rcTot.fetched === 3 && rcTot.accepted === 1 && rcTot.rejected === 2, JSON.stringify(rcTot));
  check('recruitee ingest: no partial runs', rcTot.partialRuns === 0, JSON.stringify(rcSum));
  const rcGate = gateCheck(dbRc, {
    'acme-rc.com|recruitee|1001': 'ACCEPT',
    'acme-rc.com|recruitee|1002': 'REJECT', // Hybrid flag
    'acme-rc.com|recruitee|1003': 'REJECT', // onsite Dallas office
  });
  check('recruitee gate: 0 false accepts', rcGate.falseAccepts === 0, `${rcGate.falseAccepts} false accepts`);
  check('recruitee gate: 0 false rejects', rcGate.falseRejects === 0, `${rcGate.falseRejects} false rejects`);
  check('recruitee public query lists exactly the 1 accepted job', rcGate.live.length === 1, `got ${rcGate.live.length}`);
  dbRc.close();
  fs.unlinkSync(DB_RC);

  // --- Personio: XML parsing (collision traps + empty-description skip) ----
  const PN_DE = 'https://acme.jobs.personio.de/xml?language=en';
  const PN_COM = 'https://acme.jobs.personio.com/xml?language=en';
  const pnFetch = makeCannedFetch({
    [PN_DE]: [{ status: 200, body: personioXml }],
  });
  const pnRes = await fetchPersonioJobs('acme', pnFetch);
  check('personio: 2 postings from 3 positions (1 empty skipped)', pnRes.postings.length === 2 && pnRes.skippedEmpty === 1, `got ${pnRes.postings.length}, skippedEmpty=${pnRes.skippedEmpty}`);
  check('personio: no partial on a clean feed', pnRes.partial === false, JSON.stringify(pnRes.errors));
  check('personio: feedHost reported', pnRes.feedHost === 'de', pnRes.feedHost);
  const pn1 = pnRes.postings.find((p) => p.ats_job_id === '2001');
  check('personio: inner <name> does not win over position name (collision trap)', pn1.title === 'Customer Success Manager', pn1.title);
  check('personio: description is both sections joined (>=400 chars)', pn1.description.length >= 400 && pn1.description.includes('fully remote') && pn1.description.includes('About the Role'), `len ${pn1.description.length}`);
  check('personio: CDATA HTML stripped to text', !pn1.description.includes('<p>') && !pn1.description.includes('<![CDATA['));
  check('personio: url built from slug + id', pn1.url === 'https://acme.jobs.personio.de/job/2001', pn1.url);
  check('personio: workplaceType is null (feed has no remote flag)', pn1.workplaceType === null);
  const pn2 = pnRes.postings.find((p) => p.ats_job_id === '2002');
  check('personio: additionalOffices joined into location_raw', pn2.location_raw === 'Chicago, Berlin', pn2.location_raw);
  check('personio: parseFeed finds all 3 positions incl. the empty one', parseFeed(personioXml).length === 3);
  check('personio: feedUrls are .de first, .com second', feedUrls('acme')[0] === PN_DE && feedUrls('acme')[1] === PN_COM);

  // --- Personio: .de 404 falls back to .com (not partial) -------------------
  const pnFallbackFetch = makeCannedFetch({
    [PN_DE]: [{ status: 404, body: '<html>Page Not Found</html>' }],
    [PN_COM]: [{ status: 200, body: personioXml }],
  });
  const pnFallbackRes = await fetchPersonioJobs('acme', pnFallbackFetch);
  check('personio: .de 404 + .com 200 is a complete run (not partial)', pnFallbackRes.postings.length === 2 && pnFallbackRes.partial === false && pnFallbackRes.errors.length === 0 && pnFallbackRes.feedHost === 'com', JSON.stringify({ n: pnFallbackRes.postings.length, partial: pnFallbackRes.partial, errors: pnFallbackRes.errors, feedHost: pnFallbackRes.feedHost }));

  // --- Personio: 404 on both hosts => partial, no postings ------------------
  const pn404Fetch = makeCannedFetch({
    [PN_DE]: [{ status: 404, body: '<html>Page Not Found</html>' }],
    [PN_COM]: [{ status: 404, body: '<html>Page Not Found</html>' }],
  });
  const pn404Res = await fetchPersonioJobs('acme', pn404Fetch);
  check('personio: unknown slug (404 both hosts) is partial with 0 postings', pn404Res.postings.length === 0 && pn404Res.partial === true, JSON.stringify(pn404Res.errors));

  // --- Personio: ingest end-to-end (own DB) --------------------------------
  const DB_PN = '/tmp/jobs-fetchers2-personio-test.db';
  if (fs.existsSync(DB_PN)) fs.unlinkSync(DB_PN);
  const dbPn = openDb(DB_PN);
  const { summaries: pnSum, totals: pnTot } = await runIngest(dbPn, [
    { id: 'acme-pn.com', name: 'Acme PN', domain: 'acme-pn.com', careersUrl: 'https://acme-pn.com/careers', atsType: 'personio', atsSlug: 'acme', atsEvidenceUrl: 'https://acme-pn.com/careers', hqCountry: 'US', usVerified: true, usEvidenceUrl: 'https://acme-pn.com/about', usVerifiedAt: new Date().toISOString() },
  ], pnFetch);
  check('personio ingest: 2 fetched, 1 accepted, 1 rejected', pnTot.fetched === 2 && pnTot.accepted === 1 && pnTot.rejected === 1, JSON.stringify(pnTot));
  check('personio ingest: no partial runs', pnTot.partialRuns === 0, JSON.stringify(pnSum));
  const pnGate = gateCheck(dbPn, {
    'acme-pn.com|personio|2001': 'ACCEPT',
    'acme-pn.com|personio|2002': 'REJECT', // hybrid role text
  });
  check('personio gate: 0 false accepts', pnGate.falseAccepts === 0, `${pnGate.falseAccepts} false accepts`);
  check('personio gate: 0 false rejects', pnGate.falseRejects === 0, `${pnGate.falseRejects} false rejects`);
  check('personio public query lists exactly the 1 accepted job', pnGate.live.length === 1, `got ${pnGate.live.length}`);
  dbPn.close();
  fs.unlinkSync(DB_PN);

  console.log(failures === 0 ? 'FETCHERS2 TEST: PASS' : `FETCHERS2 TEST: FAIL (${failures} failures)`);
  db.close();
  fs.unlinkSync(DB);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FETCHERS2 TEST: CRASH', err);
  try { db.close(); } catch {}
  try { fs.unlinkSync(DB); } catch {}
  process.exit(1);
});
