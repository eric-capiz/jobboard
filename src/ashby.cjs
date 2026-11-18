// ashby.cjs — Ashby job-board fetcher.
// GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Response: { jobs: [{ id, title, isRemote, workplaceType, location,
// address: { postalAddress }, secondaryLocations, descriptionPlain,
// descriptionHtml, publishedAt, ... }] }.
// CRITICAL (Genspark): isRemote is true for Hybrid too — NEVER gate on it.
// Gate on workplaceType === 'Remote' only, as a prefilter in ingest; the
// full-text verifier still decides every posting that reaches it.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

function normalizeJob(job) {
  let location = '';
  if (job.location) location = String(job.location);
  else if (job.address && job.address.postalAddress) {
    const a = job.address.postalAddress;
    location = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
  }
  const description = job.descriptionPlain || stripHtml(job.descriptionHtml || job.description || '');
  return {
    company: null, // filled in by ingest.cjs
    ats: 'ashby',
    ats_job_id: String(job.id),
    title: String(job.title || '').trim(),
    location_raw: location.trim(),
    description: description.trim(),
    url: job.jobUrl || job.applicationUrl || '',
    posted_at: job.publishedAt || job.createdAt || null,
    workplaceType: job.workplaceType || null,
    // isRemote deliberately NOT carried through — it lies for Hybrid jobs.
  };
}

// Returns { postings, partial, errors, pages }.
async function fetchAshbyJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const res = await fetchJsonWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
  if (!res.ok) {
    return { postings: [], partial: true, errors: [{ url, error: res.error, status: res.status }], pages: 1 };
  }
  const arr = Array.isArray(res.json.jobs) ? res.json.jobs : (Array.isArray(res.json) ? res.json : []);
  return {
    postings: arr.filter((j) => j && j.id != null).map(normalizeJob),
    partial: false,
    errors: [],
    pages: 1,
  };
}

module.exports = { fetchAshbyJobs, normalizeJob };
