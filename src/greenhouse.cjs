// greenhouse.cjs — Greenhouse board fetcher.
// GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
// Response: { jobs: [{ id, title, location: { name }, content (HTML),
// absolute_url, updated_at, ... }] }. Greenhouse has NO remote field —
// full-text verification decides; this fetcher only normalizes.
// Pure function of (slug, fetchFn, opts). No network of its own.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

function normalizeJob(slug, job) {
  const location = job.location && job.location.name ? String(job.location.name) : '';
  const description = stripHtml(job.content || '');
  return {
    company: null, // filled in by ingest.cjs
    ats: 'greenhouse',
    ats_job_id: String(job.id),
    title: String(job.title || '').trim(),
    location_raw: location.trim(),
    description,
    url: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
    posted_at: job.updated_at || null,
    workplaceType: null, // Greenhouse exposes no workplace type
  };
}

// Returns { postings, partial, errors, pages }.
// partial = true if any page failed (caller must NOT close jobs from it).
async function fetchGreenhouseJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const postings = [];
  const errors = [];
  let partial = false;
  let pages = 0;
  // The board endpoint returns the full board in one response; follow a
  // `meta.next` link defensively if the API ever paginates.
  let url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const seenUrls = new Set();
  while (url && !seenUrls.has(url)) {
    seenUrls.add(url);
    pages++;
    const res = await fetchJsonWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
    if (!res.ok) {
      errors.push({ url, error: res.error, status: res.status });
      partial = true;
      break;
    }
    const jobs = Array.isArray(res.json.jobs) ? res.json.jobs : [];
    for (const job of jobs) {
      if (job && job.id != null) postings.push(normalizeJob(slug, job));
    }
    const next = res.json.meta && (res.json.meta.next || res.json.meta.next_url);
    // Round 5 (Genspark): meta.next used to be followed verbatim — a
    // compromised/misbehaving board could point pagination at any URL.
    // Only boards-api.greenhouse.io is ever fetched.
    if (typeof next === 'string' && next.length) {
      let nextHost = null;
      try { nextHost = new URL(next).host; } catch { nextHost = null; }
      if (nextHost === 'boards-api.greenhouse.io') {
        url = next;
      } else {
        url = null;
        partial = true;
        errors.push({ url: next, error: 'next_url_unexpected_host' });
        break;
      }
    } else {
      url = null;
    }
    // Safety cap: a board should never need more than 20 pages.
    if (pages >= 20) { partial = true; errors.push({ url, error: 'page_cap_reached' }); break; }
  }
  return { postings, partial, errors, pages };
}

module.exports = { fetchGreenhouseJobs, normalizeJob };
