// regressions-test.cjs — regression tests for the ChatGPT round-2 fixes.
// 1. Evidence bug (§4): positive phrase ONLY in the title must store
//    evidence from the title, never a description slice.
// 2. Stale update (§5): re-ingest with changed title/location/URL must
//    update the public row AND store a new posting_versions row.
// 3. Rate limiter (§6): two companies on the same ATS host in one process
//    share one limiter (same instance + spaced requests).
// 4. ChatGPT's exact example (re-vote #2): "Candidates may work remotely,
//    subject to our approved hiring locations." must REJECT as
//    state_restricted — asserted here explicitly, not just via the gate
//    fixtures, in the exact posting shape the gate harness supplies.
// 5. State exclusions cover ALL 50 states + DC (ChatGPT re-vote #3): the
//    old exclusion regex hard-coded a 16-state subset, so "except Idaho"
//    ACCEPTed. The pattern is now generated from the full state arrays.
// 6. Genspark re-vote nits (round 7): "required to travel" phrasing,
//    CA$ prefix, and the "Remote (US)" paren form in the US signal.
// 7. Case-sensitive "except IN" (ChatGPT re-vote #4, round 8): uppercase
//    IN in an exclusion context rejects (original-case text); lowercase
//    "in rare cases" still accepts; all-caps documents skip the rule.
// 8. Recall gaps (Mistral #5, round 9): real phrasings the old signal
//    lists missed — "across America", "WFH", "Work location: Remote",
//    "USA-based", "W-2", "across the US" — plus the traps that must still
//    REJECT ("across Latin America" is not a US signal; a non-US posting
//    with WFH wording still rejects).
// Canned data only. Exit 0 = all pass.
'use strict';

const fs = require('fs');
const { openDb, upsertCompany, ingestPosting, listLiveJobs } = require('./db.cjs');
const { verifyPosting } = require('./verifier.cjs');
const { ingestCompany, limiterForHost, resetHostLimiters } = require('./ingest.cjs');

const DB = '/tmp/jobs-regressions-test.db';
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = openDb(DB);

// ingestPosting FK-references companies(id): upsert the company first.
upsertCompany(db, {
  id: 'acme.com', name: 'Acme Corp', domain: 'acme.com',
  careersUrl: 'https://acme.com/careers', atsType: 'greenhouse', atsSlug: 'acme',
  atsEvidenceUrl: 'https://acme.com/careers', hqCountry: 'US', usVerified: true,
  usEvidenceUrl: 'https://acme.com/about', usVerifiedAt: new Date().toISOString(),
});

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const FILLER = 'You will support customers by phone, email, and chat, and help resolve questions about products and services. This is a full-time position with benefits including health insurance, paid time off, and a 401(k) retirement plan. We are an equal opportunity employer and welcome applicants from all backgrounds. You will work with a friendly team and have clear goals and regular feedback. Strong written communication skills and attention to detail are important. Experience with customer support tools is helpful but not required. We provide training and the equipment you need to do the job well. Applicants must be authorized to work in the United States. Salary $60,000 per year.';

(async () => {
  // --- 1. Title-only positive evidence -------------------------------------
  // Positive phrase "fully remote" appears ONLY in the title. The
  // description has a US signal ("authorized to work in the United States",
  // "$60,000", "401(k)") but no remote wording at all.
  const titleJob = {
    companyId: 'acme.com', atsType: 'greenhouse', atsJobId: 't1',
    title: 'Customer Success Manager - Fully Remote',
    location: 'Remote - United States',
    description: FILLER,
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/t1',
  };
  const v = verifyPosting(titleJob);
  check('title-only positive still ACCEPTs', v.verdict === 'ACCEPT', v.reason);
  check('evidence field is title', v.field === 'title', `got field=${v.field}`);
  check('evidence is the title sentence, not a description slice',
    v.evidence === 'customer success manager - fully remote', `got evidence=${JSON.stringify(v.evidence)}`);
  ingestPosting(db, titleJob, v);
  const stored = db.prepare('SELECT evidence, evidence_field FROM verifications WHERE posting_id = ? ORDER BY id DESC LIMIT 1')
    .get('acme.com|greenhouse|t1');
  check('stored verification evidence is the title sentence',
    stored && stored.evidence === 'customer success manager - fully remote', JSON.stringify(stored));
  check('stored verification evidence_field is title',
    stored && stored.evidence_field === 'title', JSON.stringify(stored));

  // --- 2. Stale update: changed title/location/URL --------------------------
  const jobV1 = {
    companyId: 'acme.com', atsType: 'greenhouse', atsJobId: 's1',
    title: 'Customer Success Manager', location: 'Remote - United States',
    description: 'This is a fully remote position. Work from anywhere in the United States — remote in all 50 states; no travel or office attendance required. ' + FILLER,
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/s1',
  };
  const v1 = verifyPosting(jobV1);
  check('v1 verifies ACCEPT', v1.verdict === 'ACCEPT', v1.reason);
  ingestPosting(db, jobV1, v1);

  const jobV2 = {
    ...jobV1,
    title: 'Senior Customer Success Manager - Fully Remote',
    location: 'Remote - USA',
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/s1-updated',
  };
  const v2 = verifyPosting(jobV2);
  check('v2 (changed title/location/URL) verifies ACCEPT', v2.verdict === 'ACCEPT', v2.reason);
  const out2 = ingestPosting(db, jobV2, v2);
  check('re-ingest returns updated', out2.action === 'updated', JSON.stringify(out2));
  const pub = listLiveJobs(db).find((j) => j.id === 'acme.com|greenhouse|s1');
  check('public query returns NEW title', pub && pub.title === 'Senior Customer Success Manager - Fully Remote', JSON.stringify(pub && pub.title));
  check('public query returns NEW location', pub && pub.location === 'Remote - USA', JSON.stringify(pub && pub.location));
  check('public query returns NEW canonical URL', pub && pub.canonical_url === 'https://boards.greenhouse.io/acme/jobs/s1-updated', JSON.stringify(pub && pub.canonical_url));
  const vers2 = db.prepare("SELECT COUNT(*) c FROM posting_versions WHERE posting_id = 'acme.com|greenhouse|s1'").get().c;
  check('version row stored for v2 (2 versions)', vers2 === 2, `got ${vers2}`);

  // Location-only change must ALSO trigger a new version (proves location
  // is in the content hash, not just title/description).
  const jobV3 = { ...jobV2, location: 'Remote - United States' };
  const v3 = verifyPosting(jobV3);
  check('v3 (location-only change) verifies ACCEPT', v3.verdict === 'ACCEPT', v3.reason);
  ingestPosting(db, jobV3, v3);
  const vers3 = db.prepare("SELECT COUNT(*) c FROM posting_versions WHERE posting_id = 'acme.com|greenhouse|s1'").get().c;
  check('version row stored for location-only change (3 versions)', vers3 === 3, `got ${vers3}`);
  const pub3 = listLiveJobs(db).find((j) => j.id === 'acme.com|greenhouse|s1');
  check('public query returns v3 location', pub3 && pub3.location === 'Remote - United States', JSON.stringify(pub3 && pub3.location));

  // --- 3. Shared per-host rate limiter --------------------------------------
  resetHostLimiters();
  const limA = limiterForHost('boards-api.greenhouse.io', 3);
  const limB = limiterForHost('boards-api.greenhouse.io', 3);
  check('same host returns the SAME limiter instance', limA === limB);
  const limC = limiterForHost('api.lever.co', 3);
  check('different host returns a DIFFERENT limiter', limC !== limA);

  // Behavioral: two greenhouse companies ingested in one process must have
  // their requests spaced by the shared 3 rps limiter (~333ms). With a
  // per-company limiter the second company's first request would fire
  // immediately after the first company's last one (~0ms gap).
  const gh = require('./testdata/greenhouse-acme.json');
  const GH1 = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
  const GH1P2 = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&page=2';
  const GH2 = 'https://boards-api.greenhouse.io/v1/boards/beta/jobs?content=true';
  const GH2P2 = 'https://boards-api.greenhouse.io/v1/boards/beta/jobs?content=true&page=2';
  const stamps = [];
  const fetchFn = async (url) => {
    stamps.push({ url, at: Date.now() });
    // Slug-aware canned data: beta's page 1 must point its meta.next at
    // beta's page 2, or the fetcher (which follows meta.next verbatim)
    // would request acme's page-2 URL and the stamps would misattribute it.
    let body;
    if (url.includes('/beta/')) {
      body = url.includes('page=2') ? gh.page2
        : { ...gh.page1, meta: { next: 'https://boards-api.greenhouse.io/v1/boards/beta/jobs?content=true&page=2' } };
    } else {
      body = url.includes('page=2') ? gh.page2 : gh.page1;
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const mkCompany = (id, slug) => ({
    id, name: id, domain: id, careersUrl: `https://${id}/careers`, atsType: 'greenhouse',
    atsSlug: slug, atsEvidenceUrl: `https://${id}/careers`, hqCountry: 'US',
    usVerified: true, usEvidenceUrl: `https://${id}/about`, usVerifiedAt: new Date().toISOString(),
  });
  resetHostLimiters();
  await ingestCompany(db, mkCompany('acme.com', 'acme'), fetchFn);
  await ingestCompany(db, mkCompany('beta.com', 'beta'), fetchFn);
  const acmeLast = stamps.filter((s) => s.url.startsWith(GH1)).map((s) => s.at).pop();
  const betaFirst = stamps.filter((s) => s.url.startsWith(GH2)).map((s) => s.at)[0];
  const gap = betaFirst - acmeLast;
  check('second company on same host waits for shared limiter (gap >= 250ms)', gap >= 250, `gap=${gap}ms`);

  // --- 4. ChatGPT's exact example: approved hiring locations ---------------
  // Mirror the gate fixture harness exactly: title/location/description/
  // applyUrl, description padded past the 400-char minimum. First run the
  // gate's own fixture objects (identical input to what gate.cjs runs),
  // then a freshly built posting carrying the exact sentence.
  const positives = require('./positives.cjs');
  for (const id of ['neg-11', 'neg-12', 'neg-13']) {
    const fx = positives.find((f) => f.id === id);
    const rv = verifyPosting(fx);
    check(`gate fixture ${id} rejects as state_restricted`, rv.verdict === 'REJECT' && rv.reason === 'state_restricted', `got ${rv.verdict}/${rv.reason}`);
  }
  const chatGptExample = {
    title: 'Customer Service Representative',
    location: 'Remote - United States',
    description: 'Candidates may work remotely, subject to our approved hiring locations. ' + FILLER,
    applyUrl: 'https://example.com/jobs/chatgpt-example',
  };
  const ev = verifyPosting(chatGptExample);
  check('ChatGPT exact example rejects', ev.verdict === 'REJECT', `got ${ev.verdict}/${ev.reason}`);
  check('ChatGPT exact example reason is state_restricted', ev.reason === 'state_restricted', `got ${ev.reason}`);

  // --- 5. State exclusions cover ALL 50 states + DC (ChatGPT re-vote #3) ---
  // The old exclusion regex hard-coded a 16-state subset, so "except Idaho"
  // ACCEPTed. The pattern is now generated from the full US_STATES /
  // US_STATE_ABBREV arrays. Test every state + DC in each exclusion form,
  // plus abbrev forms and legitimate mentions that must still ACCEPT.
  const { US_STATES, US_STATE_ABBREV } = require('./verifier.cjs');
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  const statePosting = (sentence) => ({
    title: 'Customer Success Manager',
    location: 'Remote - United States',
    description: sentence + ' ' + FILLER,
    applyUrl: 'https://example.com/jobs/state-test',
  });
  const expectReject = (label, sentence, reason) => {
    const r = verifyPosting(statePosting(sentence));
    check(label, r.verdict === 'REJECT' && r.reason === reason, `got ${r.verdict}/${r.reason}`);
  };
  const expectAccept = (label, sentence) => {
    const r = verifyPosting(statePosting(sentence));
    check(label, r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  };
  for (const s of US_STATES) {
    const name = titleCase(s);
    expectReject(`except ${name} rejects`, `Fully remote within the United States, except ${name}.`, 'state_restricted');
    expectReject(`excluding ${name} rejects`, `Fully remote within the United States, excluding ${name}.`, 'state_restricted');
    expectReject(`not available in ${name} rejects`, `Fully remote within the United States. Not available in ${name}.`, 'state_restricted');
    expectReject(`except residents of ${name} rejects`, `Fully remote within the United States, except residents of ${name}.`, 'state_restricted');
    expectReject(`${name}-only rejects`, `Fully remote within the United States. ${name}-only role.`, 'state_restricted');
  }
  for (const a of US_STATE_ABBREV) {
    // IN is covered too (round 8): the case-sensitive rule on the
    // original-case text catches uppercase "IN" in an exclusion context,
    // while lowercase "in" stays ordinary English.
    expectReject(`except ${a} rejects`, `Fully remote within the United States, except ${a}.`, 'state_restricted');
  }
  // Abbrev "-only" forms (sample: the full-name loop above covers every state).
  for (const a of ['CA', 'TX', 'NY', 'ID', 'DC']) {
    expectReject(`${a}-only rejects`, `Fully remote within the United States. ${a}-only role.`, 'state_restricted');
  }
  // Legitimate mentions that must still ACCEPT (no exclusion trigger).
  expectAccept('HQ in Idaho accepts', 'Fully remote within the United States. Our headquarters is in Idaho and our team collaborates online daily.');
  expectAccept('team members in Maine accepts', 'Fully remote within the United States. Team members in Maine collaborate daily across time zones.');
  expectAccept('"except in rare cases" accepts (lowercase in = English, not Indiana)', 'Fully remote within the United States, except in rare cases approved by your manager.');
  // Round 8: lone "except IN" now REJECTs (case-sensitive rule on the
  // original-case text). Was ACCEPT before the fix — the documented gap
  // ChatGPT re-vote #4 closed.
  expectReject('lone "except IN" rejects (round 8 case-sensitive rule)', 'Fully remote within the United States, except IN.', 'state_restricted');
  expectReject('except CA, IN, OH rejects via list-mates', 'Fully remote within the United States, except CA, IN, and OH.', 'state_restricted');
  // Plain "residents of X" with no "except" is the generic rule, not the
  // exclusion pattern — one sample proves it covers any state.
  {
    const r = verifyPosting(statePosting('Fully remote within the United States. Residents of Vermont are not eligible.'));
    check('residents of Vermont (no except) rejects as residents_of_state', r.verdict === 'REJECT' && r.reason === 'residents_of_state', `got ${r.verdict}/${r.reason}`);
  }

  // --- 6. Genspark re-vote nits (round 7) -----------------------------------
  // (a) "required to travel" / "requires travel" phrasings slipped through:
  // the travel regex had travel\s+(is\s+)?required and must travel but not
  // required\s+to\s+travel or require[sd]?\s+travel. (b) CA$70,000 passed:
  // the prefix regex matched C$/A$ but not the two-letter CA$. (c) A posting
  // located "Remote (US)" with no other US mention failed closed: the paren
  // form was missing from US_SIGNAL (only the dash form was there).
  // The gate fixtures neg-22/23/24 + pos-23 cover the same cases; assert
  // them here explicitly in the exact posting shape the gate runs.
  for (const id of ['neg-22', 'neg-23', 'neg-24']) {
    const fx = positives.find((f) => f.id === id);
    const rv = verifyPosting(fx);
    const want = id === 'neg-24' ? 'non_us_currency' : 'travel_required';
    check(`gate fixture ${id} rejects as ${want}`, rv.verdict === 'REJECT' && rv.reason === want, `got ${rv.verdict}/${rv.reason}`);
  }
  {
    const fx = positives.find((f) => f.id === 'pos-23');
    const rv = verifyPosting(fx);
    check('gate fixture pos-23 (Remote (US), signal-free text) accepts', rv.verdict === 'ACCEPT', `got ${rv.verdict}/${rv.reason}`);
  }
  const NO_SIGNAL_FILLER = ' You will support customers by phone, email, and chat, and help resolve questions about products and services. This is a full-time position with benefits including health insurance and paid time off. We welcome all qualified applicants. The schedule is Monday through Friday during standard business hours. You will work with a friendly team and have clear goals and regular feedback. Strong written communication skills and attention to detail are important. Experience with customer support tools is helpful but not required. We provide training and the equipment you need to do the job well.';
  const r7Posting = (sentence, location) => ({
    title: 'Customer Success Manager',
    location: location || 'Remote - United States',
    description: sentence + NO_SIGNAL_FILLER,
    applyUrl: 'https://example.com/jobs/r7-test',
  });
  {
    const r = verifyPosting(r7Posting('You are required to travel to HQ twice a year. Fully remote in the United States.'));
    check('"required to travel to HQ" rejects as travel_required', r.verdict === 'REJECT' && r.reason === 'travel_required', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('This role requires travel to client sites twice a month. Fully remote in the United States.'));
    check('"requires travel to client sites" rejects as travel_required', r.verdict === 'REJECT' && r.reason === 'travel_required', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('This role requires occasional travel to team offsites. Fully remote in the United States.'));
    check('"requires occasional travel" rejects as travel_required', r.verdict === 'REJECT' && r.reason === 'travel_required', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('Salary CA$70,000 per year. Fully remote in the United States.'));
    check('"CA$70,000" rejects as non_us_currency', r.verdict === 'REJECT' && r.reason === 'non_us_currency', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('Salary A$70,000 per year. Fully remote in the United States.'));
    check('"A$70,000" rejects as non_us_currency', r.verdict === 'REJECT' && r.reason === 'non_us_currency', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('Fully remote role. Work from home anywhere in the country.', 'Remote (US)'));
    check('"Remote (US)" location with signal-free text accepts', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('Fully remote role. Work from home anywhere in the country.', 'Remote - US'));
    check('"Remote - US" location with signal-free text accepts (control)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('You may occasionally travel to team meetings. Fully remote in the United States.'));
    check('optional travel still accepts (control)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(r7Posting('You will review CAD files daily. Fully remote in the United States.'));
    check('CAD skill still accepts (control)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }

  // --- 7. Case-sensitive "except IN" (ChatGPT re-vote #4, round 8) --------
  // The verifier now checks the ORIGINAL-CASE text: uppercase IN in an
  // exclusion context rejects as state_restricted; lowercase "in" is
  // ordinary English and still accepts. The all-caps guard skips the rule
  // when the document has no lowercase letters at all ("EXCEPT IN RARE
  // CASES" is English, not Indiana) — the documented gap for all-caps.
  // The gate fixtures neg-25/pos-24 cover the same cases; assert them
  // here explicitly in the exact posting shape the gate runs.
  {
    const fx = positives.find((f) => f.id === 'neg-25');
    const rv = verifyPosting(fx);
    check('gate fixture neg-25 (except IN) rejects as state_restricted', rv.verdict === 'REJECT' && rv.reason === 'state_restricted', `got ${rv.verdict}/${rv.reason}`);
  }
  {
    const fx = positives.find((f) => f.id === 'pos-24');
    const rv = verifyPosting(fx);
    check('gate fixture pos-24 (except in rare cases) accepts', rv.verdict === 'ACCEPT', `got ${rv.verdict}/${rv.reason}`);
  }
  const inPosting = (sentence) => ({
    title: 'Customer Success Manager',
    location: 'Remote - United States',
    description: sentence + ' ' + FILLER,
    applyUrl: 'https://example.com/jobs/in-test',
  });
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except IN.'));
    check('"except IN" (mixed-case doc) rejects as state_restricted', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, excluding IN.'));
    check('"excluding IN" rejects as state_restricted', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States. Not available in IN.'));
    check('"Not available in IN" rejects as state_restricted', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except in rare cases approved by your manager.'));
    check('"except in rare cases" (lowercase in) still accepts', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    // All-caps document, round 9: the whole description (sentence +
    // filler) has no lowercase letters, but the rule no longer skips it —
    // case is judged PER SENTENCE and "RARE CASES" is a known
    // ordinary-English continuation of "in", so this accepts by
    // disambiguation, not by the old guard.
    const allCaps = {
      title: 'CUSTOMER SUCCESS MANAGER',
      location: 'REMOTE - UNITED STATES',
      description: ('FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN RARE CASES. ' + FILLER).toUpperCase(),
      applyUrl: 'https://example.com/jobs/in-test-caps',
    };
    const r = verifyPosting(allCaps);
    check('all-caps "EXCEPT IN RARE CASES" accepts (continuation, round 9)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except Indiana.'));
    check('"except Indiana" rejects as state_restricted (control: full name)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except CA, IN, and OH.'));
    check('"except CA, IN, OH" rejects as state_restricted (control: list-mates)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }

  // --- 8. Recall gaps: new US-signal / positive phrasings -------------------
  // Uses the section-7 NO_SIGNAL_FILLER (no US signal: no United States /
  // US / nationwide / 401(k) / W-2 / E-Verify / authorized / EEO /
  // America), so each ACCEPT below is attributable to exactly the new
  // phrasing — the file-level FILLER would mask them (it contains
  // "401(k)" and "authorized to work in the United States").
  const recallPost = (title, location, text) => ({
    title, location, description: text + NO_SIGNAL_FILLER,
    applyUrl: 'https://example.com/jobs/recall',
  });
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote',
      'Our distributed team works across America. This is a fully remote position. Work from home.'));
    check('"across America" ACCEPTs as a US signal', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote - United States',
      'WFH flexible schedule with no office days. You will support customers by phone and email.'));
    check('"WFH flexible" ACCEPTs (positive evidence)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Work location: Remote',
      'We are hiring a customer support agent for our team in the United States. You will help customers by phone and email.'));
    check('"Work location: Remote" ACCEPTs (location-field positive)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote, USA-based candidates only',
      'This is a fully remote position. You will support customers by phone and email.'));
    check('"USA-based candidates only" ACCEPTs as a US signal', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote',
      'This is a fully remote position. We offer W-2 employment with benefits and paid time off.'));
    check('"W-2 employment" ACCEPTs (lowercase w-2 signal; old /\\bW-2\\b/ was dead code)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote',
      'This is a fully remote position. Work from anywhere across the US.'));
    check('"across the US" ACCEPTs as a US signal', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote',
      'This is a fully remote position. Our distributed team works across Latin America. Work from home.'));
    check('"across Latin America" still REJECTs (no US signal)', r.verdict === 'REJECT' && r.reason === 'no_us_signal', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(recallPost('Customer Support Agent', 'Remote',
      'WFH flexible schedule with no office days. Our team is based in Toronto, Canada.'));
    check('WFH wording in a non-US posting still REJECTs', r.verdict === 'REJECT', `got ${r.verdict}/${r.reason}`);
  }

  // --- 9. All-caps IN disambiguation (ChatGPT re-vote #5) ------------------
  // Round 8's per-document guard is gone: case is judged per SENTENCE.
  // In an all-caps sentence, bare IN and IN + an unlisted word REJECT
  // (fail closed); IN + a known ordinary-English continuation ACCEPTs.
  // Mixed-case sentences keep round-8 behaviour exactly.
  const capsPost = (text) => ({
    title: 'CUSTOMER SUCCESS MANAGER',
    location: 'REMOTE - UNITED STATES',
    description: (text + ' ' + FILLER).toUpperCase(),
    applyUrl: 'https://example.com/jobs/in-caps-9',
  });
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN. This is a fully remote position.'));
    check('all-caps "EXCEPT IN." REJECTs (bare IN = Indiana)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN residents. This is a fully remote position.'));
    check('all-caps "EXCEPT IN RESIDENTS." REJECTs (IN + noun = state)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN applicants. This is a fully remote position.'));
    check('all-caps "EXCEPT IN APPLICANTS." REJECTs (ambiguous: fail closed)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN rare cases. This is a fully remote position.'));
    check('all-caps "EXCEPT IN RARE CASES." ACCEPTs (known continuation)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN certain circumstances. This is a fully remote position.'));
    check('all-caps "EXCEPT IN CERTAIN CIRCUMSTANCES." ACCEPTs (known continuation)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(capsPost('Fully remote within the United States, except IN some cases. This is a fully remote position.'));
    check('all-caps "EXCEPT IN SOME CASES." ACCEPTs (known continuation)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States. EXCEPT IN RARE CASES. This is a fully remote position.'));
    check('mixed doc, all-caps trigger sentence "EXCEPT IN RARE CASES." ACCEPTs', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except IN residents. This is a fully remote position.'));
    check('mixed "except IN residents." REJECTs (round-8 behaviour kept)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except in certain circumstances. This is a fully remote position.'));
    check('mixed "except in certain circumstances." ACCEPTs (lowercase in)', r.verdict === 'ACCEPT', `got ${r.verdict}/${r.reason}`);
  }
  {
    const r = verifyPosting(inPosting('Fully remote within the United States, except IN certain circumstances. This is a fully remote position.'));
    check('mixed "except IN certain circumstances." REJECTs (round-8 behaviour kept)', r.verdict === 'REJECT' && r.reason === 'state_restricted', `got ${r.verdict}/${r.reason}`);
  }

  console.log(failures === 0 ? 'REGRESSIONS TEST: PASS' : `REGRESSIONS TEST: FAIL (${failures} failures)`);
  db.close();
  fs.unlinkSync(DB);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('REGRESSIONS TEST: CRASH', err);
  try { db.close(); } catch {}
  try { fs.unlinkSync(DB); } catch {}
  process.exit(1);
});
