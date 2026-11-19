// recruitee.cjs — Recruitee board fetcher.
// GET https://<slug>.recruitee.com/api/offers/  (trailing slash is the form
// Recruitee's own widget uses)
// Response: { offers: [{ id, slug, title, location, locations: [{ city,
// state, country }], description (full markdown), requirements,
// published_at ("2026-11-13 14:57:55 UTC" — NOT ISO-8601), careers_url,
// remote, hybrid, on_site, status, employment_type_code, salary, ... }] }.
// The list response carries the FULL description — NO detail GET is needed
// (a detail endpoint exists at /api/offers/{id} but returns the same offer).
// No pagination fields appear in the payloads; the largest board verified
// live (11 offers) came back complete in one fetch. Loop defensively on a
// meta.next if one ever appears, same-host only (Greenhouse pattern).
// Landmines (verified live 2026-11-19): published_at is "YYYY-MM-DD
// HH:MM:SS UTC" — parse it to ISO before storing. An unknown slug returns
// HTTP 404 (treat as "not a Recruitee board / dead slug", not retryable
// beyond the standard backoff). This is an undocumented widget endpoint,
// not a contractual API — keep the standard 3 rps limiter + 429 backoff.
// workplaceType is DIRECTLY available: remote -> 'remote', hybrid ->
// 'Hybrid' (prefilter rejects), on_site -> 'Onsite' (prefilter rejects).
// Pure function of (slug, fetchFn, opts). No network of its own.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

const MAX_PAGES = 20; // Defensive only: no pagination observed live.

// "2026-11-13 14:57:55 UTC" -> "2026-11-13T14:57:55Z". Anything else is
// passed through unchanged (never crash on a date format).
function parsePublishedAt(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC$/i);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return s || null;
}

function normalizeJob(offer) {
  const description = [
    stripHtml(offer.description || ''),
    stripHtml(offer.requirements || ''),
  ].filter(Boolean).join('\n');
  let location = '';
  if (offer.location) location = String(offer.location);
  else if (Array.isArray(offer.locations) && offer.locations.length) {
    location = offer.locations
      .map((l) => [l.city, l.state, l.country].filter(Boolean).join(', '))
      .filter(Boolean)
      .join(' / ');
  }
  let workplaceType = null;
  if (offer.remote === true) workplaceType = 'remote';
  else if (offer.hybrid === true) workplaceType = 'Hybrid';
  else if (offer.on_site === true) workplaceType = 'Onsite';
  return {
    company: null, // filled in by ingest.cjs
    ats: 'recruitee',
    ats_job_id: String(offer.id != null ? offer.id : (offer.slug || '')),
    title: String(offer.title || '').trim(),
    location_raw: location.trim(),
    description,
    url: offer.careers_url || '',
    posted_at: parsePublishedAt(offer.published_at),
    workplaceType,
  };
}

// Returns { postings, partial, errors, pages }.
async function fetchRecruiteeJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const postings = [];
  const errors = [];
  let partial = false;
  let pages = 0;
  if (!slug) {
    return { postings, partial: true, errors: [{ error: 'recruitee_slug_missing' }], pages };
  }
  let url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  const seenUrls = new Set();
  const seenIds = new Set();
  while (url && !seenUrls.has(url)) {
    seenUrls.add(url);
    pages++;
    const res = await fetchJsonWithRetry(fetchImpl, url, { limiter, maxRetries: opts.maxRetries });
    if (!res.ok) {
      errors.push({ url, error: res.error, status: res.status });
      partial = true;
      break;
    }
    const json = res.json || {};
    const offers = Array.isArray(json.offers) ? json.offers : (Array.isArray(json) ? json : []);
    for (const offer of offers) {
      if (!offer || (offer.id == null && !offer.slug)) continue;
      const key = String(offer.id != null ? offer.id : offer.slug);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      // Only published offers are live; the endpoint is documented to
      // return published ones, but filter defensively.
      if (offer.status && String(offer.status).toLowerCase() !== 'published') continue;
      postings.push(normalizeJob(offer));
    }
    const next = json.meta && (json.meta.next || json.meta.next_url);
    if (typeof next === 'string' && next.length) {
      let nextHost = null;
      try { nextHost = new URL(next).host; } catch { nextHost = null; }
      if (nextHost && nextHost.endsWith('.recruitee.com')) {
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
    if (pages >= MAX_PAGES) { partial = true; errors.push({ url, error: 'page_cap_reached' }); break; }
  }
  return { postings, partial, errors, pages };
}

module.exports = { fetchRecruiteeJobs, normalizeJob, parsePublishedAt };
