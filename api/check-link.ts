/* Link checker — verifies board apply URLs server-side.
 *
 * POST { links: [{ id, url, title, company }] } and the endpoint
 * fetches each URL from the server (Render) and returns evidence,
 * not a verdict: HTTP status, final URL after redirects, page
 * <title>, whether the job title appears in the page, whether an
 * apply affordance is present, and whether the page looks like a
 * search/list page, a removed-job page, or a JS shell. The caller
 * (the link-verify coordinator + helpers) turns that evidence into
 * GOOD / BROKEN-FIXABLE / BROKEN-UNFIXABLE verdicts.
 *
 * WHY SERVER-SIDE: the VM cannot fetch employer/ATS hosts directly
 * — each new host pops a per-site approval card. The VM only ever
 * talks to Render (one host, no cards); Render does the fetching.
 * Plain fetch only — no Chromium: the Render service forces
 * JOBBOARD_NO_RENDER=1, and a status + redirect + content sniff
 * is enough to separate a live job page from a dead/redirected one
 * on every ATS the board uses (Greenhouse 404s removed jobs,
 * Workday redirects removed jobs to search, Paylocity/SmartRecruiters
 * 404 or redirect). No MongoDB, no board writes — read-only.
 *
 * LIMITS: at most 25 links per call (same batch shape as find-jobs),
 * 8s per hop, max 5 redirects, concurrency 5, soft 50s deadline —
 * links not started by the deadline come back { error: 'deadline' }
 * so the caller can retry them. Auth mirrors /api/state: the
 * x-sync-key header must match SYNC_KEY.
 *
 * FIX-FINDING (separate step, not this endpoint): for a BROKEN job,
 * re-run POST /api/test-company for that company with the same
 * resume — if the job is still listed, its current apply URL is the
 * fix candidate; verify the candidate here before calling it fixed.
 */

import {
  authorized,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';

const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_LINKS = 25;
const CONCURRENCY = 5;
const SOFT_DEADLINE_MS = 50000;
const MAX_HTML_BYTES = 200 * 1024;

export interface LinkCheckInput {
  id: string;
  url: string;
  title?: string;
  company?: string;
}

export interface LinkCheckResult {
  id: string;
  url: string;
  finalUrl: string;
  status: number;
  redirects: number;
  /** Page <title>, '' when absent. */
  pageTitle: string;
  /** Distinctive job-title words found in the page / total. */
  titleWordsMatched: number;
  titleWordsTotal: number;
  /** Normalized full title string appears in the page. */
  exactTitleInPage: boolean;
  /** An apply affordance ("Apply now", "Apply for this job", …). */
  hasApply: boolean;
  /** Final URL / title looks like a search or listing page, not a
   *  job detail page. */
  isSearchPage: boolean;
  /** Visible text is tiny — a JS shell with no server content, so
   *  title/hasApply evidence is weak for this link. */
  isShell: boolean;
  /** 404/410, or removed/expired/not-found language on the page. */
  notFound: boolean;
  /** First 400 chars of visible text, for the human classifier. */
  snippet: string;
  /** Fetch/parse failure, or 'deadline' when the batch ran out of
   *  time before this link started. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Pure helpers — exported for the offline test suite.                 */
/* ------------------------------------------------------------------ */

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'in', 'of', 'at', 'with', 'to',
  'remote', 'hybrid', 'onsite', 'on-site', 'part-time', 'parttime',
  'full-time', 'fulltime', 'i', 'ii', 'iii', 'iv',
]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distinctive words of a job title: lowercase, de-punctuated,
 *  stopwords and 1–2 letter tokens dropped. */
export function titleWords(title: string): string[] {
  return normalizeText(title)
    .split(' ')
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w));
}

/** Strip tags from HTML. When keepScripts is false, script/style
 *  bodies are removed first (visible text); when true they are kept
 *  (ATS job data often lives in embedded JSON). */
export function htmlToText(html: string, keepScripts: boolean): string {
  let s = html;
  if (!keepScripts) {
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  }
  return normalizeText(s.replace(/<[^>]+>/g, ' '));
}

export function extractPageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return normalizeText(m[1]).replace(/\s+/g, ' ').trim();
}

const NOT_FOUND_PATTERNS = [
  /this job (has been removed|is no longer available|has expired|is no longer accepting|has closed|has been filled)/i,
  /(the position|this posting|this opening|this requisition)[^.]{0,80}(no longer available|has been removed|has expired|is no longer accepting|not found|has closed)/i,
  /job (not found|no longer exists|has expired|unavailable)/i,
  /posting (not found|no longer available|has expired)/i,
  /no longer accepting applications/i,
  /this job posting (is|has) (expired|closed|removed)/i,
  /we['’]re sorry[^.]{0,80}(not found|no longer)/i,
];

export function looksNotFound(status: number, textAll: string): boolean {
  if (status === 404 || status === 410) return true;
  return NOT_FOUND_PATTERNS.some((re) => re.test(textAll));
}

const APPLY_PATTERNS = [
  /apply now/i,
  /apply for this job/i,
  /apply to this job/i,
  /apply today/i,
  /apply online/i,
  /submit (your )?application/i,
  /apply for this position/i,
];

/** An apply affordance in the visible text. */
export function hasApplyAffordance(visibleText: string): boolean {
  return APPLY_PATTERNS.some((re) => re.test(visibleText));
}

/** Does the final URL look like a job-detail page (numeric id,
 *  Workday /job/ slug, /jobs/<id>, requisition id, …)? */
export function looksLikeDetailUrl(url: string): boolean {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return (
    /\/jobs?\/\d{3,}/i.test(path) ||
    /\/job\/[^/]+\/[^/]+/i.test(path) ||
    /\/position\/[^/]+/i.test(path) ||
    /\/requisition\/[^/]+/i.test(path) ||
    /[?&](jobid|job_id|reqid|requisitionid|id)=\d{3,}/i.test(url) ||
    /\/\d{5,}(\/|$|\?)/.test(path)
  );
}

export function looksLikeSearchPage(url: string, pageTitle: string): boolean {
  let pathname = '';
  let search = '';
  try {
    const u = new URL(url);
    pathname = u.pathname.toLowerCase();
    search = u.search.toLowerCase();
  } catch {
    return false;
  }
  if (looksLikeDetailUrl(url)) return false;
  if (/^\s*(search|browse|find)\s+(a\s+)?jobs?\b/i.test(pageTitle)) return true;
  if (/\/search\/?$/.test(pathname)) return true;
  if (/^\/(jobs|careers|job-search)\/?$/.test(pathname)) return true;
  if (/[?&](q|query|keyword|search)=/.test(search)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function fetchOne(
  link: LinkCheckInput,
  deadline: number,
): Promise<LinkCheckResult> {
  const base: LinkCheckResult = {
    id: link.id,
    url: link.url,
    finalUrl: link.url,
    status: 0,
    redirects: 0,
    pageTitle: '',
    titleWordsMatched: 0,
    titleWordsTotal: 0,
    exactTitleInPage: false,
    hasApply: false,
    isSearchPage: false,
    isShell: false,
    notFound: false,
    snippet: '',
  };
  let current = link.url;
  let status = 0;
  let html = '';
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const r = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (JobBoard Finder)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      status = r.status;
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc || hop === MAX_REDIRECTS) break;
        current = new URL(loc, current).toString();
        base.redirects = hop + 1;
        continue;
      }
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf.slice(0, MAX_HTML_BYTES));
      html = new TextDecoder('utf-8').decode(bytes);
      break;
    }
  } catch (e) {
    return { ...base, status, error: e instanceof Error ? e.message : 'fetch failed' };
  }

  base.finalUrl = current;
  base.status = status;
  if (!html) {
    return { ...base, error: status ? `HTTP ${status} (empty body)` : 'no response' };
  }

  const textAll = htmlToText(html, true);
  const textVisible = htmlToText(html, false);
  base.pageTitle = extractPageTitle(html);
  const words = titleWords(link.title ?? '');
  base.titleWordsTotal = words.length;
  if (words.length > 0) {
    const hay = ` ${textAll} `;
    base.titleWordsMatched = words.filter((w) => hay.includes(` ${w} `)).length;
    const normTitle = normalizeText(link.title ?? '');
    base.exactTitleInPage = normTitle.length > 0 && textAll.includes(normTitle);
  }
  base.hasApply = hasApplyAffordance(textVisible);
  base.isSearchPage = looksLikeSearchPage(current, base.pageTitle);
  base.isShell = textVisible.length < 400;
  base.notFound = looksNotFound(status, textAll);
  base.snippet = textVisible.slice(0, 400);
  void deadline;
  return base;
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST { links: [{ id, url, title, company }] }' });
  }
  const links = (req.body?.links ?? []) as LinkCheckInput[];
  if (!Array.isArray(links) || links.length === 0) {
    return res.status(400).json({ error: 'links required' });
  }
  if (links.length > MAX_LINKS) {
    return res.status(400).json({ error: `at most ${MAX_LINKS} links per call` });
  }
  for (const l of links) {
    if (!l || typeof l.id !== 'string' || typeof l.url !== 'string') {
      return res.status(400).json({ error: 'each link needs id + url' });
    }
  }

  const deadline = Date.now() + SOFT_DEADLINE_MS;
  const results: LinkCheckResult[] = new Array(links.length);
  let next = 0;

  async function worker() {
    while (next < links.length) {
      const i = next++;
      if (Date.now() > deadline) {
        results[i] = {
          id: links[i].id,
          url: links[i].url,
          finalUrl: links[i].url,
          status: 0,
          redirects: 0,
          pageTitle: '',
          titleWordsMatched: 0,
          titleWordsTotal: 0,
          exactTitleInPage: false,
          hasApply: false,
          isSearchPage: false,
          isShell: false,
          notFound: false,
          snippet: '',
          error: 'deadline',
        };
        continue;
      }
      results[i] = await fetchOne(links[i], deadline);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, worker));
  return res.status(200).json({ results });
}
