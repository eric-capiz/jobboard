// workday.cjs — Workday CXS board fetcher.
// POST https://{host}/wday/cxs/{tenant}/{site}/jobs
//   body { appliedFacets: {}, limit: 20, offset, searchText: "" }
// Response: { total, jobPostings: [{ title, externalPath, locationsText,
// postedOn, bulletFields: [strings] }] }.
// The LIST response has no full description — only bulletFields. The full
// text lives behind a detail GET per job:
//   GET https://{host}/wday/cxs/{tenant}/{site}/job/{path-after-/job/}
//     -> { jobPostingInfo: { jobDescription (HTML), title, location,
//          startDate, jobReqId, externalUrl } }
// The detail URL is built by stripping everything up to and including the
// FIRST "/job/" in externalPath and appending the remainder to the CXS
// base + "/job/". That handles both externalPath forms the list API
// returns ("/job/Loc/Title_REQ" and "/en-US/{site}/job/Loc/Title_REQ").
// Verified against 5 independent public sources (cleanjobdata, dev.to,
// AI-skills fetch-workday-jobs, applymate-jobcopilot #30, GM/NVIDIA
// endpoint register) — all agree on BASE/job/{job_path} and on
// jobPostingInfo.jobDescription as the description field.
// Landmines (Genspark + cleanjobdata): limit silently caps at 20 (never
// ask for more); Akamai throttles mid-pagination; 10,000-result cap on
// large tenants; rate-limiting is by source IP across ALL tenants. So:
// page by offset until offset >= total, compare LISTINGS received vs
// total and mark partial if short, never close postings from a partial
// crawl. A failed detail fetch skips that posting (no thin-description
// insert — the verifier would reject it for description_too_short anyway)
// and marks the run partial; the job stays live from the previous run.
// Dedupe key: jobReqId from the detail response when present, else the
// LAST segment of externalPath. The same requisition is listed once per
// location with different location segments but the same final segment
// (Title_ReqID) — keying on the full path would triple-list it.
// Pure function of (slug, fetchFn, opts). No network of its own.
'use strict';

const { stripHtml, createRateLimiter, fetchJsonWithRetry } = require('./fetch-util.cjs');

const PAGE_SIZE = 20; // Workday caps limit at 20 silently — never ask for more.
const MAX_PAGES = 500; // 500 * 20 = 10,000, the documented result cap.

// Detail URL: CXS base + "/job/" + the part of externalPath after "/job/".
// Handles "/job/Loc/Title_REQ" and "/en-US/{site}/job/Loc/Title_REQ".
function detailUrl(host, tenant, site, externalPath) {
  const idx = String(externalPath || '').indexOf('/job/');
  const rest = idx >= 0 ? String(externalPath).slice(idx + 5) : '';
  if (!rest) return null;
  return `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/job/${rest}`;
}

function normalizeJob(host, tenant, site, listJob, detail) {
  const externalPath = String(listJob.externalPath || '');
  const segments = externalPath.split('/').filter(Boolean);
  const lastSegment = segments.length ? segments[segments.length - 1] : externalPath;
  const info = (detail && detail.jobPostingInfo) || {};
  const description = info.jobDescription
    ? stripHtml(info.jobDescription)
    : stripHtml((Array.isArray(listJob.bulletFields) ? listJob.bulletFields : []).map((b) => String(b)).join('\n'));
  return {
    company: null, // filled in by ingest.cjs
    ats: 'workday',
    ats_job_id: info.jobReqId ? String(info.jobReqId) : lastSegment,
    title: String(info.title || listJob.title || '').trim(),
    location_raw: String(info.location || listJob.locationsText || '').trim(),
    description,
    // Public job page is /en-US/{site}/job/... — but the list API
    // sometimes returns externalPath already starting with "/job/...",
    // in which case the locale+site segment must be added back.
    url: info.externalUrl || (externalPath
      ? `https://${host}${externalPath.startsWith('/job/') ? `/en-US/${site}${externalPath}` : externalPath}`
      : null),
    posted_at: info.startDate || listJob.postedOn || null,
    workplaceType: null, // Workday exposes no workplace type
  };
}

// slug is "tenant/site" (from build-companies). opts.host is the FULL host
// (e.g. acme.wd5.myworkdayjobs.com) — the wd number varies per tenant and
// cannot be guessed, so a missing host is an error, not a wd5 default.
// Returns { postings, partial, errors, pages }.
async function fetchWorkdayJobs(slug, fetchFn, opts = {}) {
  const fetchImpl = fetchFn || globalThis.fetch;
  const limiter = opts.limiter || createRateLimiter(opts.maxRps || 3);
  const host = opts.host;
  const postings = [];
  const errors = [];
  let partial = false;
  let pages = 0;
  if (!host) {
    return { postings, partial: true, errors: [{ error: 'workday_host_missing' }], pages };
  }
  const parts = String(slug || '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return { postings, partial: true, errors: [{ error: 'workday_slug_malformed' }], pages };
  }
  const [tenant, site] = parts;
  const base = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const url = `${base}/jobs`;
  let offset = 0;
  let total = null;
  let listed = 0; // listings received (before per-location dedupe)
  const seen = new Set(); // last-segment dedupe at list stage
  const unique = [];
  while (total === null || offset < total) {
    if (pages >= MAX_PAGES) {
      partial = true;
      errors.push({ url, error: 'page_cap_reached' });
      break;
    }
    const body = JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' });
    const res = await fetchJsonWithRetry(fetchImpl, url, {
      method: 'POST', body, limiter, maxRetries: opts.maxRetries,
    });
    pages++;
    if (!res.ok) {
      errors.push({ url, error: res.error, status: res.status });
      partial = true;
      break;
    }
    const json = res.json || {};
    if (total === null) total = typeof json.total === 'number' ? json.total : 0;
    const jobs = Array.isArray(json.jobPostings) ? json.jobPostings : [];
    listed += jobs.length;
    for (const job of jobs) {
      if (!job || !job.externalPath) continue;
      const segments = String(job.externalPath).split('/').filter(Boolean);
      const key = segments.length ? segments[segments.length - 1] : String(job.externalPath);
      if (seen.has(key)) continue; // same req, another location
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
    // Received fewer LISTINGS than the API says exist (cap, short page, or
    // a failed page mid-run): partial — the caller must not close jobs from
    // this run. (Compare listings, not unique postings: per-location
    // duplicates of one requisition legitimately make postings < total.)
    partial = true;
  }
  // Detail pass: one GET per unique posting for the full description.
  for (const job of unique) {
    const dUrl = detailUrl(host, tenant, site, job.externalPath);
    if (!dUrl) {
      errors.push({ url: String(job.externalPath), error: 'workday_detail_url_unbuildable' });
      partial = true;
      continue;
    }
    const res = await fetchJsonWithRetry(fetchImpl, dUrl, {
      limiter, maxRetries: opts.maxRetries,
    });
    if (!res.ok) {
      // No description, no posting: the verifier needs >=400 chars and
      // bulletFields alone never reach it. Skip + partial; the job stays
      // live from the previous run (a partial run closes nothing).
      errors.push({ url: dUrl, error: res.error, status: res.status });
      partial = true;
      continue;
    }
    postings.push(normalizeJob(host, tenant, site, job, res.json || {}));
  }
  return { postings, partial, errors, pages };
}

module.exports = { fetchWorkdayJobs, normalizeJob, detailUrl };
