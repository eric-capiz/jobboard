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
/* Board helpers (same method as the LeadFinder engine)                */
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

function greenhouseSlug(url: string): string | null {
  const m = url.match(/(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9\-_]+)/);
  if (m) return m[1];
  try {
    const q = new URL(url).searchParams.get('for');
    return q || null;
  } catch {
    return null;
  }
}

function leverSlug(url: string): string | null {
  const m = url.match(/jobs\.lever\.co\/([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}

function ashbySlug(url: string): string | null {
  const m = url.match(/(?:jobs\.ashbyhq\.com|ashbyhq\.com)\/([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}

function jazzhrSlug(url: string): string | null {
  const m = url.match(/app\.jazz\.co\/widgets\/basic\/create\/([a-z0-9\-_]+)/);
  if (m) return m[1];
  const a = url.match(/([a-z0-9\-_]+)\.applytojob\.com/);
  return a ? a[1] : null;
}

type Board = 'greenhouse' | 'lever' | 'ashby' | 'jazzhr';

function boardFromUrl(url: string): { board: Board; slug: string } | null {
  if (url.includes('greenhouse')) {
    const s = greenhouseSlug(url);
    return s ? { board: 'greenhouse', slug: s } : null;
  }
  if (url.includes('lever.co')) {
    const s = leverSlug(url);
    return s ? { board: 'lever', slug: s } : null;
  }
  if (url.includes('ashbyhq')) {
    const s = ashbySlug(url);
    return s ? { board: 'ashby', slug: s } : null;
  }
  if (url.includes('jazz.co') || url.includes('applytojob.com')) {
    const s = jazzhrSlug(url);
    return s ? { board: 'jazzhr', slug: s } : null;
  }
  return null;
}

function discoverBoard(hubHtml: string): { board: Board; slug: string } | null {
  const gh = hubHtml.match(/https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/[a-z0-9\-_]+/);
  if (gh) {
    const s = greenhouseSlug(gh[0]);
    if (s) return { board: 'greenhouse', slug: s };
  }
  const lv = hubHtml.match(/https?:\/\/jobs\.lever\.co\/[a-z0-9\-_]+/);
  if (lv) {
    const s = leverSlug(lv[0]);
    if (s) return { board: 'lever', slug: s };
  }
  const ab = hubHtml.match(/https?:\/\/(?:jobs\.ashbyhq\.com|ashbyhq\.com)\/[a-z0-9\-_]+/);
  if (ab) {
    const s = ashbySlug(ab[0]);
    if (s) return { board: 'ashby', slug: s };
  }
  const jz = hubHtml.match(/https?:\/\/app\.jazz\.co\/widgets\/basic\/create\/[a-z0-9\-_]+/);
  if (jz) {
    const s = jazzhrSlug(jz[0]);
    if (s) return { board: 'jazzhr', slug: s };
  }
  const ap = hubHtml.match(/https?:\/\/[a-z0-9\-_]+\.applytojob\.com/);
  if (ap) {
    const s = jazzhrSlug(ap[0]);
    if (s) return { board: 'jazzhr', slug: s };
  }
  return null;
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

function toDate(raw: unknown): string {
  if (typeof raw === 'number' && raw > 0) {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  if (typeof raw === 'string' && raw) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return '';
}

async function fetchBoard(board: Board, slug: string): Promise<Posting[]> {
  if (board === 'greenhouse') {
    const data = JSON.parse(
      await fetchText(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`),
    );
    return (data.jobs ?? []).map((j: any) => ({
      title: j.title ?? '',
      location: j.location?.name ?? '',
      url: j.absolute_url ?? '',
      description: stripTags(j.content ?? ''),
      postedDate: toDate(j.created_at),
    }));
  }
  if (board === 'lever') {
    const data = JSON.parse(await fetchText(`https://api.lever.co/v0/postings/${slug}?mode=json`));
    return (Array.isArray(data) ? data : []).map((j: any) => ({
      title: j.text ?? '',
      location: j.categories?.location ?? '',
      url: j.hostedUrl ?? j.applyUrl ?? '',
      description: stripTags(j.descriptionPlain ?? j.description ?? ''),
      postedDate: toDate(j.createdAt),
    }));
  }
  if (board === 'ashby') {
    const data = JSON.parse(
      await fetchText('https://api.ashbyhq.com/posting-api/job-board/' + slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    return (data.jobs ?? []).map((j: any) => ({
      title: j.title ?? '',
      location: typeof j.location === 'string' ? j.location : (j.location?.name ?? ''),
      url: j.jobUrl ?? '',
      description: stripTags(j.description ?? ''),
      postedDate: toDate(j.publishedAt ?? j.createdAt),
    }));
  }
  if (board === 'jazzhr') {
    const js = await fetchText(`https://app.jazz.co/widgets/basic/create/${slug}`);
    return parseJazzhrWidget(js);
  }
  return [];
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
  board: { board: Board; slug: string; foundOn: string } | null;
  triedUrls: string[];
}

/** Search ONE company: detect its careers board (from its careers link,
 *  or by fetching its careers page / homepage / careers / jobs paths),
 *  read the board, and match postings to the resume. Shared by the full
 *  Find Jobs sweep and by the single-company test — so a test predicts
 *  exactly what the sweep would find for that company. Throws when the
 *  board itself fails to load (the caller counts it as a board error). */
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
  let board: { board: Board; slug: string } | null = careersUrl ? boardFromUrl(careersUrl) : null;
  let foundOn = board ? 'careers link' : '';
  const triedUrls: string[] = [];
  if (!board) {
    // Fetch the company's own pages and look for a board link: the
    // careers page first (when one was given), then the homepage. A
    // page with no board may still LINK to the careers page — the
    // homepage nav "Careers" is the classic case — so those links are
    // followed next, before the guessed /careers and /jobs paths. A
    // board link found on the company's own pages is verified; a path
    // that doesn't resolve to a board is simply skipped.
    const candidates: string[] = [];
    if (careersUrl) candidates.push(careersUrl);
    if (website) {
      const base = website.replace(/\/$/, '');
      for (const u of [website, `${base}/careers`, `${base}/jobs`]) {
        if (!candidates.includes(u)) candidates.push(u);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      const u = candidates[i];
      triedUrls.push(u);
      try {
        const html = await fetchText(u);
        const found = discoverBoard(html);
        if (found) {
          board = found;
          foundOn = u;
          break;
        }
        let at = i + 1;
        for (const link of careersLinksOnPage(html, u)) {
          if (candidates.length < 8 && !candidates.includes(link) && !triedUrls.includes(link)) {
            candidates.splice(at, 0, link);
            at++;
          }
        }
      } catch {
        // Next candidate path.
      }
    }
  }
  if (!board) {
    return { leads: [], postingsSeen: 0, board: null, triedUrls };
  }
  const postings = await fetchBoard(board.board, board.slug);
  return {
    leads: screenPostings(company.name, postings, resumeText),
    postingsSeen: postings.length,
    board: { ...board, foundOn },
    triedUrls,
  };
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
    if (!result.board) noBoard += 1;
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
