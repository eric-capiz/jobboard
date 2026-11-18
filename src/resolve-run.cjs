// resolve-run.cjs — ATS resolver runner for the pilot (and later full roster).
// Usage:
//   node resolve-run.cjs --roster <roster.json> --offset 0 --limit 500 --out pilot-500.json
//     Dry run (default): derive usable domains, write the pilot shard, no network.
//   node resolve-run.cjs --live --shard-file pilot-500.json --shard 0 --shards 5 --out results-0.json
//     Live (GitHub Actions only): fetch each company's careers pages and run
//     resolveAts. NEVER run --live from the VM: direct fetches to employer
//     sites pop per-site approval cards. Live runs belong in Actions.
// Output (live): { company, domain, ats, slug, tenant, site, crawlable,
//   evidenceUrl, error } per company + a summary block with ATS distribution.
'use strict';

const fs = require('fs');
const { resolveAts } = require('./resolver.cjs');

const SOCIAL = ['facebook.com', 'linkedin.com', 'twitter.com', 'instagram.com',
  'youtube.com', 'wikipedia.org', 'crunchbase.com', 'glassdoor.com', 'indeed.com'];

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    out[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  }
  return out;
}

function domainOf(website) {
  if (!website) return null;
  try {
    const h = new URL(website.startsWith('http') ? website : 'https://' + website)
      .hostname.replace(/^www\./, '');
    if (SOCIAL.some((s) => h === s || h.endsWith('.' + s))) return null;
    return h;
  } catch { return null; }
}

function loadRoster(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  return entries
    .map((c) => ({ name: c.name || '', website: c.website || '', domain: domainOf(c.website) }))
    .filter((c) => c.domain)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CAREER_PATHS = ['/careers', '/jobs', '/careers/', '/about/careers'];

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JobBoard-Resolver/1.0 (contact: ericcapiz@gmail.com)' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, html: await res.text(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCompany(company) {
  // Try the known careers URL first if the roster has one, else the paths.
  const urls = CAREER_PATHS.map((p) => `https://${company.domain}${p}`);
  for (const url of urls) {
    const r = await fetchText(url);
    if (!r.ok) continue;
    const found = resolveAts(company.domain, r.html || '', r.finalUrl || url);
    if (found.ats !== 'unresolved') {
      return { company: company.name, domain: company.domain, ...found, error: null };
    }
  }
  return { company: company.name, domain: company.domain, ats: 'unresolved', crawlable: false, evidenceUrl: `https://${company.domain}/careers`, error: null };
}

async function main() {
  const a = args();
  if (!a.live) {
    const roster = loadRoster(a.roster);
    const slice = roster.slice(Number(a.offset || 0), Number(a.offset || 0) + Number(a.limit || 500));
    fs.writeFileSync(a.out, JSON.stringify(slice, null, 2));
    console.log(JSON.stringify({ mode: 'dry-run', totalUsable: roster.length, shardSize: slice.length, out: a.out }));
    return;
  }

  const shard = JSON.parse(fs.readFileSync(a['shard-file'], 'utf8'));
  const shardIndex = Number(a.shard || 0);
  const shardCount = Number(a.shards || 1);
  const mine = shard.filter((_, i) => i % shardCount === shardIndex);
  const results = [];
  for (const company of mine) {
    try {
      results.push(await resolveCompany(company));
    } catch (e) {
      results.push({ company: company.name, domain: company.domain, ats: 'error', crawlable: false, error: String(e && e.message || e) });
    }
    await new Promise((r) => setTimeout(r, 350)); // ~3 req/s, be polite
  }
  const dist = {};
  for (const r of results) dist[r.ats] = (dist[r.ats] || 0) + 1;
  const crawlable = results.filter((r) => r.crawlable).length;
  fs.writeFileSync(a.out, JSON.stringify({ shard: shardIndex, results, summary: { checked: results.length, crawlable, distribution: dist } }, null, 2));
  console.log(JSON.stringify({ mode: 'live', shard: shardIndex, checked: results.length, crawlable, distribution: dist }));
}

main().catch((e) => { console.error(e); process.exit(1); });
