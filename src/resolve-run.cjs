// resolve-run.cjs — ATS resolver runner for the pilot (and later full roster).
// Usage:
//   node resolve-run.cjs --roster <roster.json> --offset 0 --limit 500 --out pilot-500.json
//     Dry run (default): derive usable domains, DEDUPE BY DOMAIN, write the
//     pilot shard, no network. Console JSON reports totalUsable,
//     uniqueDomains, duplicates, qidNamed (roster entries named only by a
//     Wikidata QID, e.g. "Q131884087" — no usable company name).
//   node resolve-run.cjs --live --shard-file pilot-500.json --shard 0 --shards 5 --out results-0.json
//     Live (GitHub Actions only): fetch each company's careers pages and run
//     resolveAts. NEVER run --live from the VM: direct fetches to employer
//     sites pop per-site approval cards. Live runs belong in Actions.
//     Probes 10 career paths; follows ONE hop from a careers page when it
//     links out to an ATS board. Every result carries fetchStatus
//     ([{url, status, error}]) so "careers page fetched, no ATS token" is
//     distinguishable from "careers page never fetched" — previously all
//     33,892 unresolved entries had error:null and fetch failures were
//     invisible. The live summary counts unresolvedNoFetch (all fetches
//     failed) and qidNamed for the shard.
// Output (live): { company, domain, ats, slug, tenant, site, crawlable,
//   evidenceUrl, fetchStatus, error } per company + a summary block with
//   ATS distribution.
'use strict';

const fs = require('fs');
const { resolveAts, ATS_TOKENS } = require('./resolver.cjs');

const SOCIAL = ['facebook.com', 'linkedin.com', 'twitter.com', 'instagram.com',
  'youtube.com', 'wikipedia.org', 'crunchbase.com', 'glassdoor.com', 'indeed.com'];

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true; // boolean flag, e.g. --live
    } else {
      out[key] = next;
      i++;
    }
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
  const mapped = entries
    .map((c) => ({ name: c.name || '', website: c.website || '', domain: domainOf(c.website) }))
    .filter((c) => c.domain)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Dedupe by domain (the roster is full of sub-units sharing one parent
  // board: marriott.com x145, schools.nyc.gov x139, ...). Keep the FIRST
  // entry per domain so a shard never resolves the same board twice.
  // Also flag QID-named entries: name is only a Wikidata QID (e.g.
  // "Q131884087") — 2,081 entries (5.9%) have no usable company name.
  const seen = new Set();
  let duplicates = 0;
  let qidNamed = 0;
  const deduped = [];
  for (const c of mapped) {
    if (/^Q\d+$/.test(c.name.trim())) qidNamed++;
    if (seen.has(c.domain)) { duplicates++; continue; }
    seen.add(c.domain);
    deduped.push(c);
  }
  return { companies: deduped, totalUsable: mapped.length, uniqueDomains: deduped.length, duplicates, qidNamed };
}

const CAREER_PATHS = ['/careers', '/jobs', '/careers/', '/about/careers',
  '/company/careers', '/about-us/careers', '/join-us', '/work-with-us',
  '/en/careers', '/careers/jobs'];

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JobBoard-Resolver/1.0 (contact: ericcapiz@gmail.com)' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
    return { ok: true, status: res.status, html: await res.text(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// First outbound link in the HTML whose URL contains a known ATS host
// token — the one-hop follow target. Only ATS hosts are ever followed
// (never an arbitrary external link), and only one hop per company.
function firstAtsLink(html, baseUrl) {
  const body = String(html || '');
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(body)) !== null) {
    let href = m[1].trim();
    if (!href) continue;
    if (href.startsWith('//')) href = `https:${href}`;
    else if (href.startsWith('/')) {
      try { href = new URL(href, baseUrl).href; } catch { continue; }
    }
    if (!/^https?:\/\//i.test(href)) continue;
    const lower = href.toLowerCase();
    if (ATS_TOKENS.some((t) => lower.includes(t))) return href;
  }
  return null;
}

function statusEntry(url, r) {
  return { url, status: r.ok ? r.status : (r.status || null), error: r.ok ? null : (r.error || 'fetch_failed') };
}

async function resolveCompany(company) {
  // Try the known careers URL first if the roster has one, else the paths.
  const urls = CAREER_PATHS.map((p) => `https://${company.domain}${p}`);
  const fetchStatus = [];
  let hopUrl = null;
  for (const url of urls) {
    const r = await fetchText(url);
    fetchStatus.push(statusEntry(url, r));
    if (!r.ok) continue;
    const found = resolveAts(company.domain, r.html || '', r.finalUrl || url);
    if (found.ats !== 'unresolved') {
      return { company: company.name, domain: company.domain, ...found, fetchStatus, error: null };
    }
    // No ATS token on this page — remember the first outbound ATS link
    // for the single one-hop follow below (e.g. a careers page that
    // links out to jobs.smartrecruiters.com or governmentjobs.com).
    if (!hopUrl) hopUrl = firstAtsLink(r.html || '', r.finalUrl || url);
  }
  if (hopUrl) {
    const r = await fetchText(hopUrl);
    fetchStatus.push(statusEntry(hopUrl, r));
    if (r.ok) {
      const found = resolveAts(company.domain, r.html || '', r.finalUrl || hopUrl);
      if (found.ats !== 'unresolved') {
        return { company: company.name, domain: company.domain, ...found, fetchStatus, error: null };
      }
    }
  }
  return { company: company.name, domain: company.domain, ats: 'unresolved', crawlable: false, evidenceUrl: `https://${company.domain}/careers`, fetchStatus, error: null };
}

async function main() {
  const a = args();
  if (!a.live) {
    const roster = loadRoster(a.roster);
    const slice = roster.companies.slice(Number(a.offset || 0), Number(a.offset || 0) + Number(a.limit || 500));
    fs.writeFileSync(a.out, JSON.stringify(slice, null, 2));
    console.log(JSON.stringify({ mode: 'dry-run', totalUsable: roster.totalUsable, uniqueDomains: roster.uniqueDomains, duplicates: roster.duplicates, qidNamed: roster.qidNamed, shardSize: slice.length, out: a.out }));
    return;
  }

  const shardRaw = JSON.parse(fs.readFileSync(a['shard-file'], 'utf8'));
  const shardEntries = Array.isArray(shardRaw) ? shardRaw : Object.values(shardRaw);
  // Dedupe by domain BEFORE sharding (same rule as the dry-run path):
  // the roster file carries duplicates (marriott.com x145,
  // schools.nyc.gov x139, ...) and the workflow passes data/roster.json
  // directly, so the dry-run dedupe alone would never take effect in
  // production. Keep the first entry per domain; drop entries with no
  // usable domain. Each shard job dedupes the same file (cheap) and then
  // takes its slice, so the split stays even.
  const seenDomains = new Set();
  let fileDuplicates = 0;
  let fileQidNamed = 0;
  const shardFile = [];
  for (const c of shardEntries) {
    const domain = c.domain || domainOf(c.website || '');
    if (!domain) continue;
    if (/^Q\d+$/.test(String(c.name || '').trim())) fileQidNamed++;
    if (seenDomains.has(domain)) { fileDuplicates++; continue; }
    seenDomains.add(domain);
    shardFile.push({ name: c.name || '', website: c.website || '', domain });
  }
  console.log(JSON.stringify({ mode: 'live', shardFileEntries: shardEntries.length, shardFileUnique: shardFile.length, fileDuplicates, fileQidNamed }));
  const shard = shardFile;
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
  // unresolvedNoFetch: unresolved AND every probed URL failed to fetch
  // (the old code lumped these with "fetched, no ATS token"). qidNamed:
  // shard entries whose company name is only a Wikidata QID.
  const unresolvedNoFetch = results.filter((r) => r.ats === 'unresolved'
    && Array.isArray(r.fetchStatus) && r.fetchStatus.length > 0
    && r.fetchStatus.every((f) => f.error != null)).length;
  const qidNamed = results.filter((r) => /^Q\d+$/.test(String(r.company || '').trim())).length;
  fs.writeFileSync(a.out, JSON.stringify({ shard: shardIndex, results, summary: { checked: results.length, crawlable, distribution: dist, unresolvedNoFetch, qidNamed } }, null, 2));
  console.log(JSON.stringify({ mode: 'live', shard: shardIndex, checked: results.length, crawlable, distribution: dist, unresolvedNoFetch, qidNamed }));
}

main().catch((e) => { console.error(e); process.exit(1); });
