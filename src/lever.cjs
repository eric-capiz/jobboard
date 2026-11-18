// lever.cjs — Lever postings fetcher.
// GET https://api.lever.co/v0/postings/{slug}?mode=json (EU: api.eu.lever.co)
// Response: array of postings [{ id, text (title), categories: { location,
// team, commitment }, descriptionPlain, additionalPlain, lists: [{ text,
// content }], hostedUrl, createdAt, workplaceType, country }].
// workplaceType ∈ unspecified | on-site | remote | hybrid. A hybrid/on-site
// flag is a PREFILTER reject in ingest (text may be silent); 'unspecified'
// goes to the full-text verifier. Full text still decides.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

function normalizeJob(posting) {
  const cats = posting.categories || {};
  const location = cats.location ? String(cats.location) : '';
  const listText = Array.isArray(posting.lists)
    ? posting.lists.map((l) => `${l.text || ''}\n${stripHtml(l.content || '')}`).join('\n')
    : '';
  const description = [
    posting.descriptionPlain || stripHtml(posting.description || ''),
    posting.additionalPlain || '',
    listText,
  ].filter(Boolean).join('\n').trim();
  return {
    company: null, // filled in by ingest.cjs
    ats: 'lever',
    ats_job_id: String(posting.id),
    title: String(posting.text || posting.title || '').trim(),
    location_raw: location.trim(),
    description,
    url: posting.hostedUrl || posting.applyUrl || '',
    posted_at: posting.createdAt || null,
    workplaceType: posting.workplaceType || null,
  };
}

// Returns { postings, partial, errors, pages }.
async function fetchLeverJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const host = opts.eu ? 'api.eu.lever.co' : 'api.lever.co';
  const url = `https://${host}/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const res = await fetchJsonWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
  if (!res.ok) {
    return { postings: [], partial: true, errors: [{ url, error: res.error, status: res.status }], pages: 1 };
  }
  // Lever returns a bare array; tolerate a { data: [...] } wrapper.
  const arr = Array.isArray(res.json) ? res.json : (Array.isArray(res.json.data) ? res.json.data : []);
  return {
    postings: arr.filter((p) => p && p.id != null).map(normalizeJob),
    partial: false,
    errors: [],
    pages: 1,
  };
}

module.exports = { fetchLeverJobs, normalizeJob };
