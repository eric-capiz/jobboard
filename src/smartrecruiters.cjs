// smartrecruiters.cjs — SmartRecruiters board fetcher.
// List:  GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=0
//   Response: { totalFound, offset, limit, content: [{ id, name, releasedDate,
//   location: { city, region, country, fullLocation, remote, hybrid },
//   ref, company, typeOfEmployment, department, experienceLevel }] }.
//   The LIST response has NO description anywhere — full text lives behind
//   a detail GET per job:
// Detail: GET https://api.smartrecruiters.com/v1/companies/{slug}/postings/{id}
//   Response: { id, name, postingUrl, applyUrl, location, releasedDate,
//   jobAd: { sections: { companyDescription, jobDescription, qualifications,
//   additionalInformation: { text } } } }.
//   Description = all four sections concatenated (jobDescription alone is
//   ~500 chars; the four together clear the verifier's 400-char bar with
//   margin — verified live on BoydGaming, combined 1,945 chars).
// Landmines (verified live 2026-11-18): limit silently caps at 100 (a
// limit=200 request echoes limit:100) — never ask for more; page by offset
// until offset >= totalFound, same trap as Workday's silent cap. An unknown
// slug returns HTTP 200 with { totalFound: 0, content: [] } — NOT a 404,
// so totalFound 0 is "board empty", never an error. Slugs are case-
// insensitive live (boydgaming == BoydGaming); use the resolver's casing.
// workplaceType is DERIVED: location.remote -> 'remote', location.hybrid
// -> 'hybrid', else null (no native workplaceType field). A failed detail
// fetch skips that posting (no thin-description insert — the verifier
// would reject it for description_too_short anyway) and marks the run
// partial; the job stays live from the previous run.
// Pure function of (slug, fetchFn, opts). No network of its own.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

const PAGE_SIZE = 100; // SmartRecruiters silently caps limit at 100 — never ask for more.
const MAX_PAGES = 200; // 200 * 100 = 20,000 postings; a board should never need more.

// Section order for the description: company context first, then the role,
// then requirements, then extras. Missing/empty sections are skipped.
const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

function detailUrl(slug, id) {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(String(id))}`;
}

function normalizeJob(slug, listJob, detail) {
  const loc = (detail && detail.location) || listJob.location || {};
  const sections = (detail && detail.jobAd && detail.jobAd.sections) || {};
  const description = SECTION_ORDER
    .map((key) => stripHtml((sections[key] && sections[key].text) || ''))
    .filter(Boolean)
    .join('\n');
  let location = '';
  if (loc.fullLocation) location = String(loc.fullLocation);
  else location = [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
  let workplaceType = null;
  if (loc.remote === true) workplaceType = 'remote';
  else if (loc.hybrid === true) workplaceType = 'Hybrid';
  return {
    company: null, // filled in by ingest.cjs
    ats: 'smartrecruiters',
    ats_job_id: String((detail && detail.id) || listJob.id),
    title: String((detail && detail.name) || listJob.name || '').trim(),
    location_raw: location.trim(),
    description,
    url: (detail && detail.postingUrl)
      || `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(String(listJob.id))}`,
    posted_at: (detail && detail.releasedDate) || listJob.releasedDate || null,
    workplaceType,
  };
}

// Returns { postings, partial, errors, pages }.
async function fetchSmartRecruitersJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const postings = [];
  const errors = [];
  let partial = false;
  let pages = 0;
  if (!slug) {
    return { postings, partial: true, errors: [{ error: 'smartrecruiters_slug_missing' }], pages };
  }
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`;
  let offset = 0;
  let total = null;
  let listed = 0;
  const seen = new Set();
  const unique = [];
  while (total === null || offset < total) {
    if (pages >= MAX_PAGES) {
      partial = true;
      errors.push({ url: base, error: 'page_cap_reached' });
      break;
    }
    const url = `${base}?limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetchJsonWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
    pages++;
    if (!res.ok) {
      errors.push({ url, error: res.error, status: res.status });
      partial = true;
      break;
    }
    const json = res.json || {};
    if (total === null) total = typeof json.totalFound === 'number' ? json.totalFound : 0;
    const jobs = Array.isArray(json.content) ? json.content : [];
    listed += jobs.length;
    for (const job of jobs) {
      if (!job || job.id == null) continue;
      const key = String(job.id);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(job);
    }
    offset += PAGE_SIZE;
    // A page that returns fewer than PAGE_SIZE jobs before total is
    // reached means the API stopped early — treat the rest as missing.
    if (jobs.length < PAGE_SIZE && offset < total) {
      partial = true;
      errors.push({ url, error: 'short_page_before_total' });
      break;
    }
  }
  if (total !== null && listed < total) {
    partial = true;
  }
  // Detail pass: one GET per unique posting for the full description.
  for (const job of unique) {
    const dUrl = detailUrl(slug, job.id);
    const res = await fetchJsonWithRetry(fetchImpl, dUrl, {
      limiter, maxRetries: opts.maxRetries,
    });
    if (!res.ok) {
      // No description, no posting: the verifier needs >=400 chars and
      // the list carries no description at all. Skip + partial; the job
      // stays live from the previous run (a partial run closes nothing).
      errors.push({ url: dUrl, error: res.error, status: res.status });
      partial = true;
      continue;
    }
    postings.push(normalizeJob(slug, job, res.json || {}));
  }
  return { postings, partial, errors, pages };
}

module.exports = { fetchSmartRecruitersJobs, normalizeJob, detailUrl };
