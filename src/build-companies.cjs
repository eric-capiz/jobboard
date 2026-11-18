// build-companies.cjs — merge resolver output + US allowlist into the
// ingest-ready companies file, with frequency tiers.
// Usage:
//   node src/build-companies.cjs --resolved data/resolved.json \
//     --allowlist data/us-allowlist.json [--db data/jobs.db] \
//     --out data/companies.json
// Inputs:
//   resolved.json — merged resolver results. Accepts any of:
//     { results: [...] } | [...] | { shard, results, summary } (one shard file)
//     Each result: { company, domain, ats, slug, tenant, site, crawlable,
//     evidenceUrl, error }. ats: greenhouse|lever|ashby|workday|
//     smartrecruiters|icims|taleo|other|unresolved.
//   us-allowlist.json — { version, companies: [{ domain, hqCountry,
//     evidenceUrl, verifiedAt }] }. Hand-maintained, first-party evidence
//     only (About/investor page HQ statement, SEC EDGAR for public cos).
//     A company is ingest-eligible ONLY if it is on this list.
//     usExpiresAt = verifiedAt + 180 days (Perplexity). Expired entries
//     do NOT verify — the company drops to tier 'held' until re-verified.
//     An entry verifies ONLY when hqCountry is exactly 'US', evidenceUrl
//     is a nonempty string, and verifiedAt is a valid date inside the
//     180-day window (round 10, ChatGPT re-vote #6: the old code defaulted
//     hqCountry to 'US' and never checked the country or the evidence URL,
//     so a "CA" entry with no evidence would have qualified as US-verified).
//     Invalid entries are REPORTED (warning per entry + count in the run
//     summary) and the company is held — never silently defaulted to US.
//   jobs.db (optional) — a company counts as "ever yielded" when it has
//     >=1 posting with verification_state='passed'. Missing db = none.
// Tiers (SYNTHESIS-DRAFT.md build order step 4):
//   A — resolved + crawlable + US-verified + ever yielded a verified job
//       (ingested every 30 min)
//   B — resolved + crawlable + US-verified + never yielded (daily)
//   C — unresolved ATS (monthly re-probe via resolve.yml, never ingested)
//   held — resolved but NOT US-verified (never ingested; HQ evidence work
//     is a manual step, not an agent guess)
// Output: array of ingest company records:
//   { id, name, domain, careersUrl, atsType, atsSlug, atsHost, atsSite,
//     atsEvidenceUrl, hqCountry, usVerified, usEvidenceUrl, usVerifiedAt,
//     usExpiresAt, tier }
// Exit 1 with a clear message if data/resolved.json is missing — the
// resolver pilot must run (in Actions) before any ingest can start.
'use strict';

const fs = require('fs');

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

function loadResolved(path) {
  if (!fs.existsSync(path)) {
    console.error(`BUILD-COMPANIES: ${path} not found — run the resolver workflow first (resolve.yml) so there is something to ingest.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.results)) return raw.results;
  console.error('BUILD-COMPANIES: resolved file has no results array.');
  process.exit(1);
}

function loadAllowlist(path) {
  if (!fs.existsSync(path)) return new Map();
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.companies || []);
  const m = new Map();
  for (const c of list) {
    if (c && c.domain) m.set(String(c.domain).toLowerCase(), c);
  }
  return m;
}

function everYielded(dbPath) {
  const yielded = new Set();
  if (!dbPath || !fs.existsSync(dbPath)) return yielded;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT DISTINCT company_id FROM postings WHERE verification_state = 'passed'").all();
    for (const r of rows) yielded.add(r.company_id);
    db.close();
  } catch (e) {
    console.error(`BUILD-COMPANIES: could not read ${dbPath} for yield history (${e.message}) — treating all as never-yielded.`);
  }
  return yielded;
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 3600 * 1000).toISOString();
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.resolved || !a.allowlist || !a.out) {
    console.error('usage: node build-companies.cjs --resolved <file> --allowlist <file> [--db <jobs.db>] --out <file>');
    process.exit(2);
  }
  const results = loadResolved(a.resolved);
  const allow = loadAllowlist(a.allowlist);
  const yielded = everYielded(a.db);

  const now = new Date();
  const companies = [];
  const tierCounts = { A: 0, B: 0, C: 0, held: 0 };
  let invalidAllowlist = 0;
  for (const r of results) {
    const domain = String(r.domain || '').toLowerCase().trim();
    if (!domain) continue;
    const entry = allow.get(domain);
    let usVerified = false;
    let usEvidenceUrl = null;
    let usVerifiedAt = null;
    let usExpiresAt = null;
    let hqCountry = null;
    if (entry) {
      // HQ evidence verifies ONLY when ALL four hold (round 10):
      // hqCountry is exactly 'US', evidenceUrl is a nonempty string,
      // verifiedAt parses to a real date, and the 180-day evidence has
      // not expired. Anything else is reported and the company is held.
      const reasons = [];
      if (entry.hqCountry !== 'US') {
        reasons.push(`hqCountry=${JSON.stringify(entry.hqCountry)} (must be 'US')`);
      }
      if (typeof entry.evidenceUrl !== 'string' || entry.evidenceUrl.trim() === '') {
        reasons.push('missing evidenceUrl');
      }
      const verifiedMs = Date.parse(entry.verifiedAt);
      if (Number.isNaN(verifiedMs)) {
        reasons.push(`verifiedAt=${JSON.stringify(entry.verifiedAt)} is not a valid date`);
      }
      if (!Number.isNaN(verifiedMs)) {
        // Expired HQ evidence does not verify (Perplexity: 180-day expiry).
        usExpiresAt = addDays(entry.verifiedAt, 180);
        if (!(new Date(usExpiresAt) > now)) {
          reasons.push(`HQ evidence expired ${usExpiresAt}`);
        }
      }
      if (reasons.length === 0) {
        usVerified = true;
        hqCountry = 'US';
        usEvidenceUrl = entry.evidenceUrl.trim();
        usVerifiedAt = entry.verifiedAt;
      } else {
        invalidAllowlist++;
        console.error(`BUILD-COMPANIES WARNING: allowlist entry for ${domain} is invalid (${reasons.join('; ')}) — company held, not US-verified.`);
      }
    }
    const crawlable = !!r.crawlable && r.ats && r.ats !== 'unresolved';
    let tier;
    if (!crawlable) tier = 'C';
    else if (!usVerified) tier = 'held';
    else if (yielded.has(domain)) tier = 'A';
    else tier = 'B';
    tierCounts[tier]++;

    companies.push({
      id: domain,
      name: r.company || domain,
      domain,
      careersUrl: r.evidenceUrl || `https://${domain}/careers`,
      atsType: r.ats || 'unresolved',
      atsSlug: r.slug || r.tenant || null,
      atsHost: r.host || r.tenant || null,
      atsSite: r.site || null,
      atsEvidenceUrl: r.evidenceUrl || null,
      hqCountry,
      usVerified,
      usEvidenceUrl,
      usVerifiedAt,
      usExpiresAt,
      tier,
    });
  }

  companies.sort((x, y) => x.domain.localeCompare(y.domain));
  fs.mkdirSync(require('path').dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify(companies, null, 2));
  console.log(JSON.stringify({
    total: companies.length, tiers: tierCounts,
    usVerified: companies.filter((c) => c.usVerified).length,
    invalidAllowlistEntries: invalidAllowlist,
    ingestEligible: companies.filter((c) => c.tier === 'A' || c.tier === 'B').length,
    out: a.out,
  }));
}

main();
