/* Finder job search — Vercel serverless function.
 *
 * Searches companies' OWN careers boards for live remote frontend postings
 * matched to the resume the user selected. It never touches aggregators,
 * never takes a URL from the client (the server pages its own companies
 * collection — no seed fallback exists), and never writes anything: leads
 * are returned to the app, and only the user can add one to the board.
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

type Board = 'greenhouse' | 'lever' | 'ashby';

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
  return null;
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

/* ------------------------------------------------------------------ */
/* Filters + resume scoring                                            */
/* ------------------------------------------------------------------ */

const TITLE_TERMS = ['front end', 'front-end', 'frontend', 'react', 'web developer', 'ui engineer', 'ui developer'];
const TITLE_EXCLUDE = ['backend', 'back-end', 'mobile', 'ios', 'android', 'manager', 'director', 'intern', 'qa ', 'data engineer', 'devops', 'security', 'designer'];
const FULLSTACK_TERMS = ['full stack', 'full-stack', 'fullstack'];
const EXCLUDED_PLACES = ['canada', 'mexico', 'brazil', 'uk', 'united kingdom', 'london', 'europe', 'emea', 'apac', 'singapore', 'india', 'australia', 'germany', 'france', 'spain', 'poland', 'portugal', 'netherlands', 'ireland', 'philippines', 'colombia', 'argentina', 'chile', 'japan', 'korea', 'china', 'israel', 'kenya', 'nigeria', 'south africa', 'new zealand'];

/** Skills the resume is checked against. A skill only counts when it
 *  actually appears in the resume text — nothing is credited that the
 *  resume doesn't claim. */
const SKILL_VOCAB: { term: string; label: string }[] = [
  { term: 'react', label: 'React' },
  { term: 'typescript', label: 'TypeScript' },
  { term: 'javascript', label: 'JavaScript' },
  { term: 'next.js', label: 'Next.js' },
  { term: 'node', label: 'Node' },
  { term: 'html', label: 'HTML' },
  { term: 'css', label: 'CSS' },
  { term: 'storybook', label: 'Storybook' },
  { term: 'lit', label: 'LitElement' },
  { term: 'design system', label: 'Design systems' },
  { term: 'redux', label: 'Redux' },
  { term: 'tailwind', label: 'Tailwind' },
  { term: 'vite', label: 'Vite' },
  { term: 'aem', label: 'AEM' },
  { term: 'figma', label: 'Figma' },
];

/** Asks that count as gaps when the posting wants them and the resume
 *  doesn't have them. Never used to invent a skill — only to flag. */
const GAP_VOCAB = ['angular', 'vue', 'svelte', 'python', 'java', 'c#', '.net', 'kubernetes', 'docker', 'graphql', 'jest', 'cypress', 'playwright', 'terraform', 'sap', 'php', 'golang', 'kafka', 'spring', 'salesforce', 'palantir'];

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

function titleVerdict(title: string): 'frontend' | 'fullstack' | null {
  const t = title.toLowerCase();
  if (TITLE_EXCLUDE.some((x) => t.includes(x))) return null;
  if (TITLE_TERMS.some((x) => t.includes(x))) return 'frontend';
  if (FULLSTACK_TERMS.some((x) => t.includes(x))) return 'fullstack';
  return null;
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

function screenPostings(company: string, postings: Posting[], resumeText: string): FinderLead[] {
  const resumeLower = resumeText.toLowerCase();
  const resumeSkills = SKILL_VOCAB.filter((s) => resumeLower.includes(s.term));
  const leads: FinderLead[] = [];
  for (const p of postings) {
    const tier = titleVerdict(p.title);
    if (!tier) continue;
    if (tier === 'fullstack') {
      const d = p.description.toLowerCase();
      if (!d.includes('react') && !d.includes('frontend') && !d.includes('front end')) continue;
    }
    const loc = locationVerdict(p.location);
    if (!loc.ok) continue;
    const hay = `${p.title} ${p.description}`.toLowerCase();
    const matched = resumeSkills.filter((s) => hay.includes(s.term));
    const overlap = resumeSkills.length === 0 ? 0 : matched.length / Math.min(resumeSkills.length, 10);
    const titleWeight = tier === 'frontend' ? 1 : 0.8;
    const matchScore = Math.round(50 * titleWeight + 50 * overlap);
    const gaps = GAP_VOCAB.filter((g) => hay.includes(g) && !resumeLower.includes(g)).slice(0, 5);
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
      strengths: matched.slice(0, 6).map((s) => s.label),
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
    const displayName = company.name;
    const careersUrl = company.careersUrl || '';
    const website = company.website || '';
    let board = careersUrl ? boardFromUrl(careersUrl) : null;
    if (!board && website) {
      // Discover the board from the company's own site: homepage first,
      // then the usual careers paths. A board link found on the company's
      // own pages is verified — a path that doesn't resolve to a board is
      // simply skipped.
      const base = website.replace(/\/$/, '');
      for (const u of [website, `${base}/careers`, `${base}/jobs`]) {
        try {
          const html = await fetchText(u);
          board = discoverBoard(html);
          if (board) break;
        } catch {
          // Next candidate path.
        }
      }
    }
    if (!board) {
      noBoard += 1;
      return [];
    }
    const postings = await fetchBoard(board.board, board.slug);
    postingsSeen += postings.length;
    return screenPostings(displayName, postings, resumeText);
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
