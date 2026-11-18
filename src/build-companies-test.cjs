// build-companies-test.cjs — HQ allowlist validation (round 10, ChatGPT
// re-vote #6). The allowlist is the sole authority for HQ verification, so
// an entry verifies ONLY when hqCountry is exactly 'US', evidenceUrl is a
// nonempty string, verifiedAt parses, and the 180-day evidence is unexpired.
// Anything else: usVerified false, tier 'held', warning on stderr, counted
// in the run summary. Runs the real CLI in a temp dir; no network, no db.
// Usage: node src/build-companies-test.cjs
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(__dirname, 'build-companies.cjs');

const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
const expired = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();

// All crawlable + resolved, so tier would be B if verified, held if not.
const CASES = [
  // [domain, allowlist entry, expectVerified, expectTier, expectWarning]
  ['ca.example', { domain: 'ca.example', hqCountry: 'CA', evidenceUrl: 'https://ca.example/about', verifiedAt: recent }, false, 'held', true], // (a) foreign HQ
  ['noev.example', { domain: 'noev.example', hqCountry: 'US', verifiedAt: recent }, false, 'held', true], // (b) missing evidenceUrl
  ['baddate.example', { domain: 'baddate.example', hqCountry: 'US', evidenceUrl: 'https://baddate.example/about', verifiedAt: 'not-a-date' }, false, 'held', true], // (c) invalid verifiedAt
  ['expired.example', { domain: 'expired.example', hqCountry: 'US', evidenceUrl: 'https://expired.example/about', verifiedAt: expired }, false, 'held', true], // (d) expired
  ['good.example', { domain: 'good.example', hqCountry: 'US', evidenceUrl: 'https://good.example/about', verifiedAt: recent }, true, 'B', false], // (e) positive control
  ['noverifiedat.example', { domain: 'noverifiedat.example', hqCountry: 'US', evidenceUrl: 'https://noverifiedat.example/about' }, false, 'held', true], // (f) missing verifiedAt
  ['absent.example', null, false, 'held', false], // (g) no allowlist entry at all: held, no warning
];

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures.push(name); console.log(`  FAIL ${name} — ${detail}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
const resolvedPath = path.join(tmp, 'resolved.json');
const allowPath = path.join(tmp, 'us-allowlist.json');
const outPath = path.join(tmp, 'companies.json');
fs.writeFileSync(resolvedPath, JSON.stringify({
  results: CASES.map(([domain]) => ({
    company: domain, domain, ats: 'greenhouse', slug: domain.split('.')[0],
    crawlable: true, evidenceUrl: `https://${domain}/careers`,
  })),
}));
fs.writeFileSync(allowPath, JSON.stringify({
  version: 1,
  companies: CASES.map(([, entry]) => entry).filter(Boolean),
}));

const run = spawnSync('node', [CLI, '--resolved', resolvedPath, '--allowlist', allowPath, '--out', outPath], { encoding: 'utf8', cwd: ROOT });
check('exit 0 (no crash on invalid verifiedAt)', run.status === 0, `status=${run.status} stderr=${run.stderr.slice(0, 300)}`);

let summary = null;
try { summary = JSON.parse(run.stdout.trim().split('\n').pop()); } catch (e) { /* handled below */ }
check('summary parses', !!summary, `stdout=${JSON.stringify(run.stdout).slice(0, 200)}`);
const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const byDomain = new Map(out.map((c) => [c.domain, c]));

for (const [domain, , expectVerified, expectTier, expectWarning] of CASES) {
  const c = byDomain.get(domain);
  check(`${domain}: usVerified=${expectVerified}`, c && c.usVerified === expectVerified, `got ${c && c.usVerified}`);
  check(`${domain}: tier=${expectTier}`, c && c.tier === expectTier, `got ${c && c.tier}`);
  const warned = run.stderr.includes(`allowlist entry for ${domain} is invalid`);
  check(`${domain}: warning=${expectWarning}`, warned === expectWarning, `stderr has warning: ${warned}`);
}
const good = byDomain.get('good.example');
check('good.example: hqCountry=US from validated entry', good && good.hqCountry === 'US', `got ${good && good.hqCountry}`);
check('good.example: usEvidenceUrl kept', good && good.usEvidenceUrl === 'https://good.example/about', `got ${good && good.usEvidenceUrl}`);
check('ca.example: hqCountry not carried over', byDomain.get('ca.example').hqCountry === null, `got ${byDomain.get('ca.example').hqCountry}`);
check('summary.invalidAllowlistEntries=5', summary && summary.invalidAllowlistEntries === 5, `got ${summary && summary.invalidAllowlistEntries}`);
check('summary.usVerified=1', summary && summary.usVerified === 1, `got ${summary && summary.usVerified}`);

if (failures.length) {
  console.log(`BUILD-COMPANIES-TEST: FAIL — ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`BUILD-COMPANIES-TEST: PASS — ${CASES.length} cases, 5 invalid entries reported, 1 verified`);
