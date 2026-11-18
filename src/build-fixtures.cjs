// build-fixtures.js — generates fixtures.json from the 309 logged live-check
// verdicts in remote-check-results.log, joined to real apply URLs from
// remote-check-list.json.
// HONESTY NOTE: full posting descriptions were NOT archived during the sweep.
// Each fixture's description is RECONSTRUCTED from the human checker's logged
// reason (the evidence they recorded) plus a fixed neutral boilerplate body.
// These fixtures test the verifier's rules against the recorded evidence;
// they are NOT the original posting text. The gate therefore proves the
// verifier rejects postings matching the recorded failure evidence — it does
// not prove it would have rejected the originals unseen.
'use strict';

const fs = require('fs');
const path = require('path');

// Round 5 (Genspark): inputs are resolved relative to THIS script file,
// not hardcoded to /home/hatch/workspace. The sweep log lives in the
// sibling apply-50 dir (~/workspace/jobboard/apply-50/); fixtures land
// next to this script.
const LOG = path.resolve(__dirname, '../../apply-50/remote-check-results.log');
const LIST = path.resolve(__dirname, '../../apply-50/remote-check-list.json');
const OUT = path.join(__dirname, 'fixtures.json');

// Neutral boilerplate appended to every reconstructed description so fixture
// text is realistic length (>400 chars). Contains no gate-relevant words:
// no hybrid/onsite/travel/location language. The 401(k) + EEO phrases are
// US signals, which is legitimate — these are US employers.
const NEUTRAL = 'We are looking for a motivated team member to join our team. '
  + 'You will support customers by phone, email, and chat, and help resolve questions '
  + 'about products and services. This is a full-time position with benefits including '
  + 'health insurance, paid time off, and a 401(k) retirement plan. We are an equal '
  + 'opportunity employer and welcome all qualified applicants. The schedule is Monday '
  + 'through Friday during standard business hours.';

function extractLocation(reason, title) {
  const m = reason.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),?\s+([A-Z]{2})\b/);
  if (m) return `${m[1]}, ${m[2]}`;
  if (/\(remote\)/i.test(title)) return 'Remote';
  return 'United States';
}

const list = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const urlById = {};
for (const job of list) urlById[job.id] = job.applyUrl;

const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
const fixtures = [];
let missingUrl = 0;

for (const line of lines) {
  const [id, verdict, company, title, ...rest] = line.split(' | ');
  const reason = rest.join(' | ');
  const applyUrl = urlById[id] || null;
  if (!applyUrl) missingUrl++;

  if (verdict === 'GONE') {
    // A gone posting has no retrievable text — the verifier must reject
    // empty input. No URL is needed for this case (fetch already failed).
    fixtures.push({
      id, company, title, location: '', description: '',
      applyUrl: applyUrl || 'https://example.invalid/gone',
      expected: 'REJECT', source: 'sweep-log', provenance: 'reconstructed', sweepVerdict: verdict, reason,
    });
    continue;
  }

  fixtures.push({
    id, company, title,
    location: extractLocation(reason, title),
    description: `${reason} ${NEUTRAL}`,
    applyUrl: applyUrl || 'https://example.invalid/missing-url',
    expected: 'REJECT', source: 'sweep-log', provenance: 'reconstructed', sweepVerdict: verdict, reason,
  });
}

// Two-sided gate (round 9, DeepSeek re-vote): fixtures.json used to
// contain ONLY the 309 sweep REJECTs — the ACCEPT side lived in
// positives.cjs, which some reviewers' fetchers could not retrieve
// (Surge serves .cjs as application/octet-stream), so the accessible
// gate looked all-negative. The hand-written fixtures (both ACCEPT and
// REJECT edges) are therefore MERGED INTO fixtures.json as well, so the
// main gate file is two-sided on its own. positives.cjs stays the
// human-editable SOURCE of the hand-written side; this script is the
// merge step. The gate reads ONLY fixtures.json, so nothing is counted
// twice. Provenance labels keep the breakdown honest.
const handWritten = require('./positives.cjs');
fixtures.push(...handWritten);

fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 2));
console.log(`fixtures: ${fixtures.length} (expected REJECT: ${fixtures.filter((f) => f.expected === 'REJECT').length}, expected ACCEPT: ${fixtures.filter((f) => f.expected === 'ACCEPT').length})`);
console.log(`missing applyUrl in list: ${missingUrl} (placeholder used, flagged in fixture)`);
console.log(`gone: ${fixtures.filter((f) => f.sweepVerdict === 'GONE').length}`);
console.log(`not-remote: ${fixtures.filter((f) => f.sweepVerdict === 'NOT REMOTE').length}`);
console.log(`hand-written merged from positives.cjs: ${handWritten.length} (ACCEPT: ${handWritten.filter((f) => f.expected === 'ACCEPT').length}, REJECT: ${handWritten.filter((f) => f.expected === 'REJECT').length})`);
