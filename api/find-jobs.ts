/* Finder job search — Vercel serverless function.
 *
 * Searches companies' OWN careers boards for live remote frontend postings
 * matched to the resume the user selected. It never touches aggregators,
 * never takes a URL from the client (companies come from the names the
 * client sends, resolved against the user's own state doc and the bundled
 * seed as a fallback), and never writes anything: leads are returned to
 * the app, and only the user can add one to the board.
 *
 * Chunked + idempotent: the client passes the names of the companies in
 * its database plus a cursor (index into that name list) and a limit; the
 * function processes that slice and returns the next cursor. A timed-out
 * chunk is simply retried — no state is written server-side, so a retry
 * can never duplicate anything.
 *
 * Auth mirrors /api/state: the x-sync-key header must match SYNC_KEY.
 */

import { MongoClient } from 'mongodb';
import { COMPANIES_SEED } from './companies-seed';

// Vercel provides process.env at runtime; the project has no @types/node,
// so declare just the shape this file uses (same approach as api/state.ts,
// which avoids the @vercel/node dependency the same way).
declare const process: { env: Record<string, string | undefined> };

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
}
interface VercelResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

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
/* State doc (the user's own company database)                         */
/* ------------------------------------------------------------------ */

let mongoClient: MongoClient | null = null;

interface StateDoc {
  _id: string;
  state?: { companies?: unknown };
}

async function getStateCompanies(): Promise<{ name: string; website: string; careersUrl: string }[]> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return [];
  if (!mongoClient) {
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
  }
  const doc = await mongoClient
    .db('dealboard')
    .collection<StateDoc>('app_state')
    .findOne({ _id: 'jobboard' });
  const list = doc?.state?.companies;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => {
      const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      return {
        name: String(o.name ?? ''),
        website: String(o.website ?? ''),
        careersUrl: String(o.careersUrl ?? ''),
      };
    })
    .filter((c) => c.name || c.website);
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

function authorized(req: VercelRequest): boolean {
  const key = req.headers['x-sync-key'];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body ?? {};
  const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
  // The client sends the NAMES of the companies in its database. The
  // function resolves those names against the user's own state doc (for
  // websites and known careers pages) and the bundled seed as a fallback.
  // It never accepts a URL from the client, so this endpoint can't be
  // used as an open proxy.
  const normName = (v: string): string =>
    v
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const rawNames: string[] = Array.isArray(body.companies)
    ? (body.companies as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const seenNameKeys = new Set<string>();
  const uniqueNames = rawNames.filter((n) => {
    const k = normName(n);
    if (!k || seenNameKeys.has(k)) return false;
    seenNameKeys.add(k);
    return true;
  });
  const cursorRaw = Number(body.cursor ?? 0);
  const limitRaw = Number(body.limit ?? 15);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? Math.floor(cursorRaw) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : 15;

  // Resolve each name: state doc first (it carries websites and careers
  // pages for everything Find Companies added), bundled seed as fallback.
  const dbMap = new Map<string, { name: string; website: string; careersUrl: string }>();
  try {
    const stateCompanies = await getStateCompanies();
    for (const c of stateCompanies) {
      const k = normName(c.name);
      if (!k) continue;
      const prev = dbMap.get(k);
      if (!prev || (!prev.careersUrl && c.careersUrl)) dbMap.set(k, c);
    }
  } catch {
    // State read failed — the seed fallback below still covers seed companies.
  }
  const seedMap = new Map<string, (typeof COMPANIES_SEED)[number]>();
  for (const s of COMPANIES_SEED) {
    const k = normName(s.n);
    if (k && !seedMap.has(k)) seedMap.set(k, s);
  }

  const startedAt = Date.now();
  const slice = uniqueNames.slice(cursor, cursor + limit);
  const leads: FinderLead[] = [];
  let postingsSeen = 0;
  let boardErrors = 0;
  let noBoard = 0;

  async function processName(name: string): Promise<FinderLead[]> {
    const k = normName(name);
    const db = dbMap.get(k);
    const seed = seedMap.get(k);
    const displayName = db?.name ?? seed?.n ?? name;
    const careersUrl = db?.careersUrl || seed?.c || '';
    const website = db?.website || seed?.w || '';
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
        const found = await processName(slice[idx]);
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
  const done = nextCursor >= uniqueNames.length;
  return res.status(200).json({
    leads,
    checked: completed.size,
    totalCompanies: uniqueNames.length,
    nextCursor: done ? null : nextCursor,
    done,
    stats: { postingsSeen, boardErrors, noBoard },
  });
}
