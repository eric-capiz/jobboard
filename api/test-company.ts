/* Single-company job test — read-only roster lookup, no writes.
 *
 * POST { company: { name, website, careersUrl }, resumeText } and the
 * endpoint runs exactly the same search the full Find Jobs sweep runs
 * for one company, business site ONLY: listings parsed straight off
 * the company's own careers page, or the job-list widget embedded in
 * that page. No board is ever fetched as a source — the only board
 * contact allowed is the apply link on a listing found on the business
 * page. Nothing is written: the company is NOT added to the database
 * and no lead touches the Pipeline — the caller decides what to do
 * with the result. That makes it a true test: if you know a company
 * is hiring for your resume's skill set, this tells you whether its
 * careers page is detected and the job found.
 *
 * The one read the endpoint does is a roster lookup: a company on
 * the roster (source !== 'Manual') is a U.S. company by
 * construction, so its blank-location / bare-'Remote' postings are
 * evaluated the same way the sweep evaluates them — without it the
 * test path defaulted isUSCompany to false and every such posting
 * came back flagged 'no location listed — verify' (312 of 400 in
 * the 2026-11-12 verify-401 run). A company the roster does not
 * know, or a manually added one, keeps the old review behavior.
 *
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY.
 *
 * PROBE MODE: POST the same body with `probe: true` and the endpoint
 * renders the given careers URL directly (no walk, no second target)
 * and returns a bounded markup outline of the rendered HTML — the
 * job-ish anchors, the detail-passing anchors, the list containers,
 * the results-count lines, and what the extractor itself parses
 * from the page. That is how an unparsed list shape is diagnosed
 * (Teleperformance's opportunities page renders 'has-listings' while
 * the extractor finds 0 postings): the outline shows the shape the
 * strategies miss, without shipping the whole page back. Read-only:
 * no database writes, no board fetch — the render opens only the
 * given careers URL, the same source discipline as the test.
 */

import {
  authorized,
  getCompaniesCollection,
  resolveIsUSCompany,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';
import {
  isJobDetailUrl,
  parseCareersPage,
  portalSearchTerm,
  sampleRenderedText,
  searchCompanyJobs,
} from './find-jobs.js';
import { renderPageHtml } from './render-page.js';

/** Strip tags + entities from a short HTML fragment to plain text. */
function stripInline(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A bounded structural outline of a rendered careers page's listing
 *  markup — pure over the HTML, so the offline suite can drive it
 *  with canned pages. The point is the detector/extractor gap: the
 *  render's listing detector counts job-looking links, the extractor
 *  parses cards — when they disagree, this says exactly what the
 *  page carries and what the extractor saw in it. */
export interface MarkupOutline {
  /** Rendered HTML size in bytes (a 3MB page is a different problem
   *  from a 30KB one). */
  htmlBytes: number;
  /** Total <a> tags on the page. */
  anchorCount: number;
  /** Anchors passing isJobDetailUrl — what the detector counts. */
  detailLinkCount: number;
  /** What parseCareersPage itself found on this HTML — the
   *  extractor's answer, next to the detector's. */
  parsedPostings: number;
  parsedTitles: string[];
  /** Job-ish anchors (href or class names a job word): href, class,
   *  inner text — the shape a list strategy must match. Capped. */
  anchors: { href: string; cls: string; text: string }[];
  /** The detail-passing anchors: href + text. Capped. */
  detailAnchors: { href: string; text: string }[];
  /** Elements whose class/id names a list container. Capped. */
  containers: { tag: string; cls: string; id: string }[];
  /** Results-count lines the detector recognizes ("Results 1 – 10
   *  of 34", "1-25 of 4,659 jobs"). */
  countLines: string[];
  /** schema.org JobPosting blocks / a __NEXT_DATA__ blob are present
   *  (a JSON shape the HTML strategies never see). */
  hasJsonLd: boolean;
  hasNextData: boolean;
  /** 200 chars around the first '"jobs"' / JobPosting mention in the
   *  page's scripts — the embedded-data hint. */
  scriptHint: string;
}

export function buildMarkupOutline(html: string, pageUrl: string): MarkupOutline {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const anchors: MarkupOutline['anchors'] = [];
  const detailAnchors: MarkupOutline['detailAnchors'] = [];
  let anchorCount = 0;
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(clean)) !== null) {
    anchorCount += 1;
    const openTag = am[0].slice(0, am[0].indexOf('>') + 1);
    const cls = (openTag.match(/class\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').slice(0, 80);
    const text = stripInline(am[2]).slice(0, 100);
    const href = am[1].trim();
    if (anchors.length < 15 && (/job|career|position|opening|apply|vacancy|role/i.test(href) || /job|career|position|opening/i.test(cls))) {
      anchors.push({ href: href.slice(0, 140), cls, text });
    }
    if (detailAnchors.length < 10) {
      try {
        const abs = new URL(href, pageUrl).href;
        if (isJobDetailUrl(abs)) detailAnchors.push({ href: abs.slice(0, 140), text });
      } catch {
        // Unresolvable href — not a detail link.
      }
    }
  }
  const containers: MarkupOutline['containers'] = [];
  const contRe = /<(div|section|article|ul|li|main|table)[^>]*(?:class|id)\s*=\s*["'][^"']*(?:job|listing|result|opening|vacancy|career|posting|position)[^"']*["'][^>]*>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = contRe.exec(clean)) !== null && containers.length < 20) {
    const tag = cm[0];
    containers.push({
      tag: (tag.match(/^<(\w+)/)?.[1] ?? '').toLowerCase(),
      cls: (tag.match(/class\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').slice(0, 80),
      id: (tag.match(/id\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').slice(0, 80),
    });
  }
  const bodyText = stripInline(clean);
  const countLines: string[] = [];
  for (const re of [
    /[\d,]+\s+(jobs?|results?|openings?|positions?|roles?)\b/gi,
    /results?\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+[\d,]+/gi,
    /[\d,]+\s*[–—-]\s+[\d,]+\s+of\s+[\d,]+\s+(jobs?|results?|openings?|positions?|roles?)\b/gi,
  ]) {
    for (const m of bodyText.matchAll(re)) {
      if (countLines.length >= 3) break;
      const v = m[0].replace(/\s+/g, ' ').trim().slice(0, 120);
      if (v && !countLines.includes(v)) countLines.push(v);
    }
    if (countLines.length >= 3) break;
  }
  let scriptHint = '';
  const hintAt = html.search(/"jobs"\s*:|JobPosting|job-results|__NEXT_DATA__/);
  if (hintAt >= 0) {
    scriptHint = html
      .slice(Math.max(0, hintAt - 100), hintAt + 100)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }
  let parsed: { title: string }[] = [];
  try {
    parsed = parseCareersPage(html, pageUrl);
  } catch {
    parsed = [];
  }
  return {
    htmlBytes: html.length,
    anchorCount,
    detailLinkCount: detailAnchors.length,
    parsedPostings: parsed.length,
    parsedTitles: parsed.slice(0, 5).map((p) => p.title),
    anchors,
    detailAnchors,
    containers,
    countLines,
    hasJsonLd: /"@type"\s*:\s*"JobPosting"/i.test(html),
    hasNextData: /__NEXT_DATA__/.test(html),
    scriptHint,
  };
}

/* Same 60s allowance as Find Jobs: a single-company test with a
 * JS-rendered careers page can spend ~30s on a cold render. */
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = req.body ?? {};
    const c = (
      typeof body.company === 'object' && body.company !== null ? body.company : {}
    ) as Record<string, unknown>;
    const name = String(c.name ?? '').trim();
    const website = String(c.website ?? '').trim();
    const careersUrl = String(c.careersUrl ?? '').trim();
    const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
    if (!name || (!website && !careersUrl)) {
      res
        .status(400)
        .json({ error: 'A company name and a website or careers link are required.' });
      return;
    }
    // Probe mode: render the given careers URL directly and return
    // the markup outline — no walk, no second target. The outline
    // is what diagnoses an unparsed list shape.
    if (body.probe === true) {
      const target = careersUrl || website;
      const rendered = await renderPageHtml(target, portalSearchTerm(resumeText));
      if (!rendered) {
        res.status(200).json({
          company: name,
          probe: true,
          renderedUrl: '',
          searchOutcome: null,
          searchMs: 0,
          renderError: 'render-null',
          renderTextSample: '',
          markup: null,
        });
        return;
      }
      res.status(200).json({
        company: name,
        probe: true,
        sourcePage: target,
        renderedUrl: rendered.renderedUrl,
        searchOutcome: rendered.searchOutcome,
        searchMs: rendered.searchMs,
        renderError: rendered.renderError ?? null,
        searchScan: rendered.searchScan ?? null,
        renderTextSample: rendered.html ? sampleRenderedText(rendered.html) : '',
        markup: rendered.html ? buildMarkupOutline(rendered.html, rendered.renderedUrl || target) : null,
      });
      return;
    }
    const result = await searchCompanyJobs(
      {
        name,
        website,
        careersUrl,
        // Read-only roster lookup (see the header): a roster company
        // is a U.S. company by construction. Best-effort — a DB
        // failure leaves isUSCompany false rather than failing the
        // test, exactly the old behavior.
        isUSCompany: await (async () => {
          try {
            const companiesCol = await getCompaniesCollection();
            return await resolveIsUSCompany(companiesCol, { name, website, careersUrl });
          } catch {
            return false;
          }
        })(),
      },
      resumeText,
      {
        renderPage: renderPageHtml,
        // Two renders per test: a no-form or failed first render retries
        // the next-best target instead of spending the test on the
        // wrong page.
        renderBudget: { used: 0, max: 2 },
      },
    );
    res.status(200).json({
      company: name,
      sourcePage: result.sourcePage,
      triedUrls: result.triedUrls,
      postingsSeen: result.postingsSeen,
      fetchOk: result.fetchOk,
      renderUsed: result.renderUsed,
      renderMs: result.renderMs,
      // True even when the render failed or found nothing — the honest
      // fire counter (renderMs can be 0 for a fast render death).
      renderAttempted: result.renderAttempted,
      renderError: result.renderError ?? null,
      // What the portal search step did, so a zero-listing render can
      // be told apart from a render that never searched.
      searchOutcome: result.searchOutcome,
      // Why the search found no box — the scan summary from the
      // rendered page. Null unless the search ended no-form.
      searchScan: result.searchScan ?? null,
      searchMs: result.searchMs,
      renderedUrl: result.renderedUrl,
      renderTextSample: result.renderTextSample,
      // Per-attempt render telemetry + the sorted target list, so a
      // zero-listing canary can say whether the retry fired, what it
      // tried, and whether a portal ever made the target list.
      renderAttempts: result.renderAttempts ?? [],
      renderTargets: result.renderTargets ?? [],
      screened: result.screened,
      leads: result.leads,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
