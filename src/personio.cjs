// personio.cjs — Personio board fetcher (XML feed, zero dependencies).
// GET https://<slug>.jobs.personio.de/xml?language=en  (also .com host)
//   Response: text/xml, root <workzag-jobs>, one <position> per published
//   job, children in this order (several optional): id, subcompany, office,
//   additionalOffices>office*, department, recruitingCategory, name,
//   jobDescriptions>jobDescription{name, value CDATA HTML}*,
//   employmentType, seniority, schedule, yearsOfExperience, keywords,
//   occupation, occupationCategory, createdAt, plus rare salaryInformation.
//   One request returns the WHOLE board; no pagination, no detail GET,
//   no API key. `language` accepts de en fr es nl it pt (default German
//   if omitted) — always request en for this board.
// Landmines (verified live 2026-11-19):
//   - <name> and <office> tag names ALSO occur inside <jobDescriptions>
//     and <additionalOffices> — strip those two blocks before reading the
//     position's own fields, or the first inner <name> wins.
//   - Language/empty rule: a position with no text in the requested
//     language keeps all other fields and returns EMPTY <jobDescriptions>
//     (German-only jobs on an ?language=en fetch). NEVER emit a thin
//     posting: skip such positions (counted as skippedEmpty). Do NOT
//     re-fetch ?language=de — a German description cannot pass the
//     English-text verifier anyway.
//   - Unknown slug answers HTTP 404 with an HTML "Page Not Found" page —
//     treat 404 (or a redirect off the jobs.personio host) as "no such
//     board". The .de host is tried first, .com second.
//   - Description values are styled HTML inside CDATA — stripHtml()
//     reduces them to text. Median ~2,800 chars per position (measured).
//   - workplaceType: null — the feed has no remote flag. Remote is only
//     an office label ("Mobil", "Remote", or a city). Full-text
//     verification decides, like Greenhouse.
//   - The live sample (src/testdata/personio-sample.xml) is RECONSTRUCTED
//     from text-fetch copies, not verbatim bytes — a fetcher run against
//     the real feed is still required before this fetcher is trusted.
// Parser: regex field extraction (non-greedy tags, CDATA unwrap, entity
// decode) — no npm deps, same approach as the published reference script.
// Pure function of (slug, fetchFn, opts). No network of its own.
'use strict';

const { stripHtml, createRateLimiter, fetchTextWithRetry } = require('./fetch-util.cjs');

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch { return ''; } });
}

function unwrapCdata(s) {
  const t = String(s || '').trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : t;
}

// First <tag>...</tag> in block (non-greedy), CDATA-unwrapped + decoded.
function extractTag(block, tag) {
  const m = String(block || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(unwrapCdata(m[1].trim())) : '';
}

// All <tag>...</tag> occurrences in block.
function extractAllTags(block, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(String(block || ''))) !== null) out.push(decodeXml(unwrapCdata(m[1].trim())));
  return out;
}

function parsePosition(block) {
  // Strip the two blocks whose inner tags collide with position-level
  // field names (<name> inside jobDescription, <office> inside
  // additionalOffices) BEFORE reading position-level fields.
  const jdBlock = extractTag(block, 'jobDescriptions');
  const addOfficesBlock = extractTag(block, 'additionalOffices');
  const head = String(block || '')
    .replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, '')
    .replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/, '');
  const id = extractTag(head, 'id');
  const name = extractTag(head, 'name');
  const offices = [extractTag(head, 'office'), ...extractAllTags(addOfficesBlock, 'office')]
    .map((o) => String(o || '').trim())
    .filter(Boolean);
  // Description: every jobDescription section, heading + stripped value.
  const descParts = [];
  const jdRe = /<jobDescription>([\s\S]*?)<\/jobDescription>/g;
  let jm;
  while ((jm = jdRe.exec(jdBlock)) !== null) {
    const sec = jm[1];
    const secName = extractTag(sec, 'name');
    const secValue = stripHtml(decodeXml(unwrapCdata(extractTag(sec, 'value'))));
    if (secValue) descParts.push(secName ? `${secName}\n${secValue}` : secValue);
  }
  return {
    company: null, // filled in by ingest.cjs
    ats: 'personio',
    ats_job_id: id,
    title: name.trim(),
    location_raw: offices.join(', ').trim(),
    description: descParts.join('\n').trim(),
    url: '', // filled in by fetchPersonioJobs (needs the slug)
    posted_at: extractTag(head, 'createdAt') || null,
    workplaceType: null,
  };
}

function parseFeed(xml) {
  const positions = [];
  const re = /<position>([\s\S]*?)<\/position>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) positions.push(parsePosition(m[1]));
  return positions;
}

function feedUrls(slug) {
  return [
    `https://${encodeURIComponent(slug)}.jobs.personio.de/xml?language=en`,
    `https://${encodeURIComponent(slug)}.jobs.personio.com/xml?language=en`,
  ];
}

// Returns { postings, partial, errors, pages, skippedEmpty }.
// skippedEmpty = positions skipped for having no description text in the
// requested language (German-only jobs on an ?language=en fetch).
async function fetchPersonioJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const postings = [];
  const errors = [];
  let partial = false;
  let skippedEmpty = 0;
  if (!slug) {
    return { postings, partial: true, errors: [{ error: 'personio_slug_missing' }], pages: 0, skippedEmpty };
  }
  const urls = feedUrls(slug);
  let xml = null;
  let feedHost = null;
  const attemptErrors = [];
  for (const url of urls) {
    const res = await fetchTextWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
    if (res.ok) { xml = res.text; feedHost = url.includes('.jobs.personio.de/') ? 'de' : 'com'; break; }
    // 404 on .de means "no such board" only after .com also fails; any
    // other failure is recorded and the next host is NOT tried (a 429/500
    // on .de says nothing about .com, and hammering the second host
    // after a rate limit is the wrong move).
    attemptErrors.push({ url, error: res.error, status: res.status });
    if (res.status !== 404) break;
  }
  if (xml == null) {
    return { postings, partial: true, errors: attemptErrors, pages: 1, skippedEmpty };
  }
  // Success: attempt errors are NOT returned — ingest treats any error as
  // a partial run, and a .de 404 followed by a good .com fetch is a
  // complete run, not a partial one. The host used is reported instead.
  const parsed = parseFeed(xml);
  const seen = new Set();
  for (const p of parsed) {
    if (!p.ats_job_id || !p.title) continue;
    if (seen.has(p.ats_job_id)) continue;
    seen.add(p.ats_job_id);
    if (!p.description || p.description.length < 400) {
      // Thin/empty description (usually a German-only job on the en
      // feed): never emit it — the verifier would reject it anyway.
      skippedEmpty++;
      continue;
    }
    p.url = `https://${encodeURIComponent(slug)}.jobs.personio.de/job/${encodeURIComponent(p.ats_job_id)}`;
    postings.push(p);
  }
  return { postings, partial, errors, pages: 1, skippedEmpty, feedHost };
}

module.exports = { fetchPersonioJobs, parseFeed, parsePosition, feedUrls };
