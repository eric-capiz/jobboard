/* Finder job search — Vercel serverless function.
 *
 * Searches companies' OWN careers boards for live remote postings
 * matched to the resume the user selected — whatever its field. It never
 * touches aggregators, never takes a URL from the client (the server
 * pages its own companies collection — no seed fallback exists), and
 * never writes anything: leads are returned to the app, which adds 60%+
 * matches to the Pipeline and leaves the rest as near misses.
 *
 * Chunked + idempotent: the server pages the companies collection by
 * insertion order with a cursor the client passes back; the function
 * processes that slice and returns the next cursor. A timed-out chunk is
 * simply retried — no state is written server-side, so a retry can never
 * duplicate anything.
 *
 * Auth mirrors /api/state: the x-sync-key header must match SYNC_KEY.
 */

import {
  authorized,
  getCompaniesCollection,
  type CompanyDoc,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';
import type { Collection } from 'mongodb';

const FETCH_TIMEOUT_MS = 6000;
const SOFT_DEADLINE_MS = 50000;
const CONCURRENCY = 5;
const MAX_LIMIT = 25;

/* ------------------------------------------------------------------ */
/* Page-fetch helpers                                                    */
/* ------------------------------------------------------------------ */

interface Posting {
  title: string;
  location: string;
  url: string;
  description: string;
  postedDate: string;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'Mozilla/5.0 (JobBoard Finder)', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function stripTags(text: string): string {
  return text
    .replace(/<script.*?<\/script>/gis, ' ')
    .replace(/<style.*?<\/style>/gis, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The job-list widget embedded IN a business careers page: some
 *  companies render their own page's job list through a JazzHR widget
 *  script. The widget is part of the page — the jobs it carries are
 *  the jobs displayed on that page, and their apply links may point at
 *  the board. Only an embed found on the business page itself is ever
 *  read; no board list page, board API, or board link is ever fetched
 *  as a source. */
function jazzhrWidgetSlug(pageHtml: string): string | null {
  const m = pageHtml.match(/app\.jazz\.co\/widgets\/basic\/create\/([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}

/** Board domains are never a source: a URL on one is skipped outright,
 *  whether the user pasted it or a page links to it. */
function isBoardUrl(url: string): boolean {
  return /greenhouse\.io|lever\.co|ashbyhq\.com|jazz\.co|applytojob\.com/i.test(url);
}

/** Parse a JazzHR basic widget script: each job is a resumator-job block
 *  with a title div, a "Location: X" span, a "Department: Y" span, and a
 *  + View details link to the apply page. The widget renders jobs
 *  client-side, but the listings themselves are IN the script text, so
 *  fetching the widget URL is enough — no browser needed. The job div id
 *  carries its posting date (job_YYYYMMDDHHMMSS_...). */
export function parseJazzhrWidget(js: string): Posting[] {
  const postings: Posting[] = [];
  const blocks = js.split('<div id="resumator-job-job_');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const dateMatch = b.match(/^(\d{4})(\d{2})(\d{2})/);
    const titleMatch = b.match(/resumator-job-title[^>]*>([^<]+)<\/div>/);
    const locMatch = b.match(/resumator-job-location[^>]*>Location:\s*<\/span>\s*([^<]+)/);
    const deptMatch = b.match(/resumator-job-department[^>]*>Department:\s*<\/span>\s*([^<]+)/);
    const linkMatch = b.match(/resumator-job-link[^>]*href="([^"]+)"/);
    const title = (titleMatch?.[1] ?? '').trim();
    if (!title || !linkMatch) continue;
    postings.push({
      title,
      location: (locMatch?.[1] ?? '').trim(),
      url: linkMatch[1].split('?')[0],
      description: (deptMatch?.[1] ?? '').trim(),
      postedDate: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '',
    });
  }
  return postings;
}

/* ------------------------------------------------------------------ */
/* Filters + resume scoring                                            */
/* ------------------------------------------------------------------ */

const EXCLUDED_PLACES = ['canada', 'mexico', 'brazil', 'uk', 'united kingdom', 'london', 'europe', 'emea', 'apac', 'singapore', 'india', 'australia', 'germany', 'france', 'spain', 'poland', 'portugal', 'netherlands', 'ireland', 'philippines', 'colombia', 'argentina', 'chile', 'japan', 'korea', 'china', 'israel', 'kenya', 'nigeria', 'south africa', 'new zealand'];

/* ------------------------------------------------------------------ */
/* Resume-driven matching — no hardcoded field                         */
/* ------------------------------------------------------------------ */

// The match vocabulary comes from the resume the user selected, not
// from a fixed list: a frontend resume matches frontend roles, a
// support resume matches support roles, and so on. Field words
// (support, customer, nurse, analyst, engineer) are NEVER stopwords —
// only function words and generic resume/posting boilerplate are.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'may',
  'might', 'do', 'does', 'did', 'we', 'you', 'they', 'he', 'she', 'it',
  'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their',
  'his', 'her', 'not', 'no', 'if', 'but', 'so', 'than', 'then', 'when',
  'while', 'who', 'whom', 'what', 'which', 'how', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own',
  'same', 'too', 'very', 'just', 'also', 'over', 'under', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'up',
  'down', 'out', 'off', 'again', 'further', 'once', 'here', 'there',
  'where', 'why', 'because', 'until', 'per', 'via', 'am',
  'experience', 'experiences', 'skills', 'skill', 'responsibilities',
  'responsible', 'duties', 'education', 'work', 'worked', 'working',
  'years', 'year', 'strong', 'excellent', 'passionate', 'proven',
  'ability', 'including', 'include', 'includes', 'team', 'teams', 'role',
  'roles', 'position', 'positions', 'company', 'companies', 'join',
  'joining', 'looking', 'seek', 'seeking', 'need', 'needs', 'required',
  'requirements', 'preferred', 'bonus', 'plus', 'etc',
]);

/** Lowercase word tokens, minus stopwords, minus pure numbers and
 *  single letters. Applied identically to resumes, titles, and posting
 *  text, so a term matches only when both sides actually use the word. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t),
  );
}

/** The resume's signature terms: its most frequent tokens, capped at
 *  40 (ties broken alphabetically for determinism). A term only counts
 *  when it actually appears in the resume text — nothing is credited
 *  that the resume doesn't claim. */
function extractResumeTerms(resumeText: string): string[] {
  const counts = new Map<string, number>();
  for (const t of tokenize(resumeText)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 40)
    .map(([t]) => t);
}

/** A posting title passes when it shares at least one word with the
 *  resume — the title gate, field-agnostic. */
function titleMatchesResume(title: string, resumeTerms: string[]): boolean {
  if (resumeTerms.length === 0) return false;
  const titleWords = new Set(tokenize(title));
  return resumeTerms.some((t) => titleWords.has(t));
}

function locationVerdict(loc: string): { ok: boolean; flag: string } {
  const l = (loc ?? '').toLowerCase();
  if (!l) return { ok: false, flag: 'no location listed' };
  if (l.includes('hybrid') || l.includes('on-site') || l.includes('onsite') || l.includes('in office')) {
    return { ok: false, flag: 'not remote' };
  }
  if (!l.includes('remote')) return { ok: false, flag: 'not remote' };
  for (const place of EXCLUDED_PLACES) {
    if (l.includes(place)) return { ok: false, flag: `excluded place: ${place}` };
  }
  const states = l.match(/\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/g) ?? [];
  if (
    l.includes('united states') ||
    l.includes('usa') ||
    l.includes('remote (usa)') ||
    /\bremote\b.*\bus\b/.test(l) ||
    l.includes('anywhere') ||
    l.includes('nationwide')
  ) {
    return { ok: true, flag: 'Remote (US)' };
  }
  if (states.length > 0 && states.every((s) => s === 'tx')) {
    return { ok: true, flag: 'Remote (TX only)' };
  }
  if (states.length > 0) return { ok: false, flag: `state-restricted remote: ${[...new Set(states)].join(', ')}` };
  return { ok: true, flag: 'Remote (no country stated — verify)' };
}

function titleVerdict(title: string, resumeTerms: string[]): boolean {
  return titleMatchesResume(title, resumeTerms);
}

function parsePay(text: string): string {
  const m = text.match(/\$[\d,]{2,}(?:\s*(?:-|–|to)\s*\$?[\d,]{2,})?/);
  return m ? m[0] : '';
}

export interface FinderLead {
  company: string;
  title: string;
  location: string;
  locationFlag: string;
  salaryText: string;
  applyUrl: string;
  description: string;
  postedDate: string;
  matchScore: number;
  strengths: string[];
  gaps: string[];
}

export interface CompanySearchInput {
  name: string;
  website: string;
  careersUrl: string;
}

export interface CompanySearchResult {
  leads: FinderLead[];
  postingsSeen: number;
  /** The business site's own careers page the jobs were read from. */
  sourcePage: string | null;
  triedUrls: string[];
}

const GENERIC_TITLE_TEXT = /^(home|about|about us|careers|jobs|job|contact|contact us|login|sign in|join our team|work with us|open positions|current openings|open roles|all roles|see all jobs|view all jobs|view jobs|see jobs|browse jobs|search jobs|browse all jobs|view openings|see openings|view open positions|all jobs|all positions|explore careers|explore jobs|learn more|apply now|view details|view job|see details)$/i;

function resolvePageLink(href: string, pageUrl: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) return null;
  try {
    const abs = new URL(h, pageUrl).href;
    return abs.startsWith('http://') || abs.startsWith('https://') ? abs : null;
  } catch {
    return null;
  }
}

function cleanTitle(text: string): string {
  return stripTags(text).replace(/\s+/g, ' ').trim();
}

function titleOk(title: string): boolean {
  if (title.length < 2 || GENERIC_TITLE_TEXT.test(title)) return false;
  // "See open roles", "View jobs", "Browse positions" — hub/hero copy,
  // never a role title.
  if (/^(see|view|browse|explore|find|search|discover)\b/i.test(title) && /\b(jobs?|roles?|openings?|positions?|careers?|opportunities)\b/i.test(title)) return false;
  return true;
}

function locationIn(text: string): string {
  const m = text.match(/Location:\s*([^<\n]{2,60})/i);
  if (m) return stripTags(m[1]).trim();
  if (/\bRemote\b/i.test(text)) return 'Remote';
  return '';
}

const APPLY_HREF = /job|apply|position|opening|detail|career|posting|vacancy|role/i;

/** Parse job listings straight off a company's own careers page HTML:
 *  job blocks (class/id mentioning job/career/position/opening) and
 *  title + View-details/Apply link pairs. Only listings with a usable
 *  title AND an apply/detail link are kept, and a block only qualifies
 *  when its link looks like a job link or the block states a location —
 *  so a hero banner, nav link, or "see open roles" hub link never
 *  qualifies. Script/style content is stripped first so widget code
 *  can't ghost-match. */
export function parseCareersPage(html: string, pageUrl: string): Posting[] {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const postings: Posting[] = [];
  const seen = new Set<string>();
  const push = (title: string, location: string, url: string | null) => {
    if (!titleOk(title) || !url || seen.has(url)) return;
    seen.add(url);
    postings.push({ title, location, url, description: '', postedDate: '' });
  };
  // Strategy A: job blocks.
  const chunks = clean.split(/(?=<[^>]*\b(?:class|id)="[^"]*(?:job|career|position|opening)[^"]*")/i);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].slice(0, 3000);
    const heading = chunk.match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    const strong = chunk.match(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/i);
    const link = chunk.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/i);
    let title = '';
    if (heading) title = cleanTitle(heading[1]);
    if (!titleOk(title) && link) title = cleanTitle(link[2]);
    if (!titleOk(title) && strong) title = cleanTitle(strong[1]);
    if (!titleOk(title)) continue;
    let apply: string | null = null;
    let first: string | null = null;
    const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(chunk)) !== null) {
      const abs = resolvePageLink(lm[1], pageUrl);
      if (!abs) continue;
      if (!first) first = abs;
      if (APPLY_HREF.test(lm[1])) {
        apply = abs;
        break;
      }
    }
    if (!apply) apply = first;
    const loc = locationIn(chunk);
    if (!apply) continue;
    if (!APPLY_HREF.test(apply) && !loc) continue;
    push(title, loc, apply);
  }
  // Strategy B: View-details / Apply links with a title just before them.
  const viewRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let vm: RegExpExecArray | null;
  while ((vm = viewRe.exec(clean)) !== null) {
    if (!/view details|view job|apply|see details|learn more/i.test(cleanTitle(vm[2]))) continue;
    const apply = resolvePageLink(vm[1], pageUrl);
    if (!apply) continue;
    const windowText = clean.slice(Math.max(0, vm.index - 900), vm.index);
    const headings = [...windowText.matchAll(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/gi)];
    const bolds = [...windowText.matchAll(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/gi)];
    let title = '';
    const lastHeading = headings[headings.length - 1];
    if (lastHeading) title = cleanTitle(lastHeading[1]);
    if (!titleOk(title)) {
      const lastBold = bolds[bolds.length - 1];
      if (lastBold) title = cleanTitle(lastBold[1]);
    }
    if (!titleOk(title)) continue;
    const loc = locationIn(windowText);
    if (!APPLY_HREF.test(apply) && !loc) continue;
    push(title, loc, apply);
  }
  return postings.slice(0, 50);
}

/** Search ONE company — business site ONLY, no exceptions. Jobs come
 *  from the company's own pages and nowhere else: listings parsed
 *  straight off its careers page, or the job-list widget embedded in
 *  that page (the widget is part of the page's own display). A board
 *  link is never fetched as a source — not a link the user pasted, not
 *  a link found on the company's pages. The ONLY board contact allowed
 *  is the apply link on a listing found on the business page: if
 *  applying takes the user to a board, that's fine, but the job itself
 *  was found on the company's site. Shared by the full Find Jobs sweep
 *  and by the single-company test — so a test predicts exactly what
 *  the sweep would find for that company. */
/** Links on a page that look like a careers page: the href mentions
 *  careers/jobs, or the link text does (nav "Careers", "Open
 *  positions", "Join our team"). Relative links resolve against the
 *  page URL. Capped at 3 so a big nav can't turn into a crawl. */
function careersLinksOnPage(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    const text = stripTags(m[2]).trim();
    const hrefHits = /career|job/i.test(href);
    const textHits = /career|job|open positions|join (us|our|the) team|work with us/i.test(text);
    if (!hrefHits && !textHits) continue;
    try {
      const abs = new URL(href, pageUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      // Unparseable href — skip.
    }
  }
  return out.slice(0, 3);
}

export async function searchCompanyJobs(
  company: CompanySearchInput,
  resumeText: string,
): Promise<CompanySearchResult> {
  const careersUrl = company.careersUrl || '';
  const website = company.website || '';
  const triedUrls: string[] = [];
  // Only pages on the business site are ever fetched: a careers link
  // the user gave (it names the company's own careers page), plus the
  // website's homepage, its nav-linked careers pages, and the /careers
  // and /jobs guesses. A board link — pasted or found on a page — is
  // never followed as a source.
  const candidates: string[] = [];
  if (careersUrl && !isBoardUrl(careersUrl)) candidates.push(careersUrl);
  if (website && !isBoardUrl(website)) {
    const base = website.replace(/\/$/, '');
    for (const u of [website, `${base}/careers`, `${base}/jobs`]) {
      if (!candidates.includes(u)) candidates.push(u);
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i];
    triedUrls.push(u);
    let html: string;
    try {
      html = await fetchText(u);
    } catch {
      continue;
    }
    // Jobs listed on the page itself.
    const pagePostings = parseCareersPage(html, u);
    if (pagePostings.length > 0) {
      return {
        leads: screenPostings(company.name, pagePostings, resumeText),
        postingsSeen: pagePostings.length,
        sourcePage: u,
        triedUrls,
      };
    }
    // Jobs displayed on the page through its embedded widget — the
    // widget is part of this page, so these jobs are still the page's
    // own listings. Their apply links may point at the board.
    const widgetSlug = jazzhrWidgetSlug(html);
    if (widgetSlug) {
      try {
        const widgetPostings = parseJazzhrWidget(
          await fetchText(`https://app.jazz.co/widgets/basic/create/${widgetSlug}`),
        );
        if (widgetPostings.length > 0) {
          return {
            leads: screenPostings(company.name, widgetPostings, resumeText),
            postingsSeen: widgetPostings.length,
            sourcePage: u,
            triedUrls,
          };
        }
      } catch {
        // Widget unreadable — keep looking at the company's own pages.
      }
    }
    let at = i + 1;
    for (const link of careersLinksOnPage(html, u)) {
      if (!isBoardUrl(link) && candidates.length < 8 && !candidates.includes(link) && !triedUrls.includes(link)) {
        candidates.splice(at, 0, link);
        at++;
      }
    }
  }
  return { leads: [], postingsSeen: 0, sourcePage: null, triedUrls };
}

function screenPostings(company: string, postings: Posting[], resumeText: string): FinderLead[] {
  const resumeTerms = extractResumeTerms(resumeText);
  const resumeSet = new Set(resumeTerms);
  const leads: FinderLead[] = [];
  for (const p of postings) {
    if (!titleVerdict(p.title, resumeTerms)) continue;
    const loc = locationVerdict(p.location);
    if (!loc.ok) continue;
    const postingWords = new Set(tokenize(`${p.title} ${p.description}`));
    const matched = resumeTerms.filter((t) => postingWords.has(t));
    const overlap = resumeTerms.length === 0 ? 0 : matched.length / Math.min(resumeTerms.length, 10);
    // The title gate already establishes title relevance, so the score
    // is 50 (title) + 50 (skill overlap). A title-only match lands in
    // the mid-50s (near miss); auto-add at 60+ needs real overlap.
    const matchScore = Math.round(50 + 50 * overlap);
    // Gaps: the posting description's most frequent terms the resume
    // doesn't mention — what the posting wants that the resume lacks.
    // Never used to invent a skill — only to flag.
    const descCounts = new Map<string, number>();
    for (const t of tokenize(p.description)) {
      if (resumeSet.has(t)) continue;
      descCounts.set(t, (descCounts.get(t) ?? 0) + 1);
    }
    const gaps = [...descCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([t]) => t);
    if (/staff|principal/.test(p.title.toLowerCase())) gaps.unshift('Staff/principal-level ask');
    leads.push({
      company,
      title: p.title,
      location: p.location,
      locationFlag: loc.flag,
      salaryText: parsePay(p.description),
      applyUrl: p.url,
      description: p.description.slice(0, 2000),
      postedDate: p.postedDate,
      matchScore,
      strengths: matched.slice(0, 6).map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
      gaps,
    });
  }
  return leads;
}

/* ------------------------------------------------------------------ */
/* Collection paging (the user's own company database)                 */
/* ------------------------------------------------------------------ */

export interface FindJobsDeps {
  companiesCol: Collection<CompanyDoc>;
}

export interface FindJobsResult {
  leads: FinderLead[];
  checked: number;
  totalCompanies: number;
  nextCursor: number | null;
  done: boolean;
  stats: { postingsSeen: number; boardErrors: number; noBoard: number };
}

export async function runFindJobs(
  deps: FindJobsDeps,
  body: { resumeText?: string; cursor?: number; limit?: number },
): Promise<FindJobsResult> {
  const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
  const cursorRaw = Number(body.cursor ?? 0);
  const limitRaw = Number(body.limit ?? 15);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? Math.floor(cursorRaw) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : 15;

  // The server pages its own companies collection (insertion order) —
  // the client never sends names, and no seed fallback exists. A company
  // not in the collection is simply not searched.
  const total = await deps.companiesCol.countDocuments();
  const slice = await deps.companiesCol
    .find({})
    .sort({ _id: 1 } as never)
    .skip(cursor)
    .limit(limit)
    .toArray();

  const startedAt = Date.now();
  const leads: FinderLead[] = [];
  let postingsSeen = 0;
  let boardErrors = 0;
  let noBoard = 0;

  async function processCompany(company: CompanyDoc): Promise<FinderLead[]> {
    const result = await searchCompanyJobs(
      { name: company.name, website: company.website || '', careersUrl: company.careersUrl || '' },
      resumeText,
    );
    postingsSeen += result.postingsSeen;
    if (!result.sourcePage) noBoard += 1;
    return result.leads;
  }

  // Small worker pool: 5 companies at a time, soft deadline so the
  // function never blows the serverless time limit mid-chunk. The cursor
  // only advances past the contiguous run of finished companies, so a
  // company cut off by the deadline is retried — never skipped — and the
  // client dedupes any lead returned twice.
  let next = 0;
  const completed = new Set<number>();
  async function worker(): Promise<void> {
    while (next < slice.length) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) return;
      const idx = next;
      next += 1;
      try {
        const found = await processCompany(slice[idx]);
        leads.push(...found);
      } catch {
        boardErrors += 1;
      }
      completed.add(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, () => worker()));

  let prefix = 0;
  while (completed.has(prefix)) prefix += 1;
  const nextCursor = cursor + prefix;
  const done = nextCursor >= total;
  return {
    leads,
    checked: completed.size,
    totalCompanies: total,
    nextCursor: done ? null : nextCursor,
    done,
    stats: { postingsSeen, boardErrors, noBoard },
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

async function handlerInner(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const body = req.body ?? {};
  const result = await runFindJobs(
    { companiesCol: await getCompaniesCollection() },
    { resumeText: body.resumeText, cursor: body.cursor, limit: body.limit },
  );
  res.status(200).json(result);
}

// Top-level guard so an unexpected error surfaces as a JSON 500 with a
// message (like /api/state) instead of an opaque invocation failure.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    await handlerInner(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
