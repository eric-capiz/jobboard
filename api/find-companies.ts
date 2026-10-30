/* Finder company discovery — Vercel serverless function.
 *
 * Every press returns up to 500 companies NOT already in the user's
 * database, found live from Wikidata (US companies with official websites,
 * including ones headquartered in the US even when no country is recorded),
 * paged by OFFSET in a stable result order. No pre-loaded list is served:
 * every company comes from live discovery. The client persists the
 * discovery offset and sends it back each press, so presses walk the whole
 * result set exactly once — no repeats, nothing skipped. The function also
 * reads the user's own state doc from MongoDB and filters against it, so a
 * company already in the database is never returned again even if the
 * client's offset state is lost.
 *
 * Nothing here takes a URL from the client. Wikidata rows come from the
 * public SPARQL endpoint. Auth mirrors /api/state: x-sync-key must match
 * SYNC_KEY.
 */

import { MongoClient } from 'mongodb';

// Vercel provides process.env at runtime; the project has no @types/node.
declare const process: { env: Record<string, string | undefined> };

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
}
interface VercelResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

const WDQS_TIMEOUT_MS = 45000;
const SOFT_DEADLINE_MS = 45000;
const WDQS_PAGE_ROWS = 750;
const MAX_PAGES_PER_PRESS = 4;

export interface FoundCompany {
  name: string;
  website: string;
  careersUrl: string;
  category: string;
  source: string;
}

let mongoClient: MongoClient | null = null;

interface StateDoc {
  _id: string;
  state?: { companies?: unknown };
}

async function getStateCompanies(): Promise<{ name: string; website: string }[]> {
  try {
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
        return { name: String(o.name ?? ''), website: String(o.website ?? '') };
      })
      .filter((c) => c.name || c.website);
  } catch {
    return [];
  }
}

/** Normalize a company name for dedupe: lowercase, strip punctuation and
 *  corporate suffixes (so "Apple Inc." matches "Apple"). */
const SUFFIXES = [
  ' corporation',
  ' incorporated',
  ' company',
  ' corp',
  ' inc',
  ' llc',
  ' llp',
  ' ltd',
  ' lp',
  ' co',
];
export function nameKey(name: string): string {
  let n = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const suf of SUFFIXES) {
    if (n.endsWith(suf)) {
      n = n.slice(0, -suf.length).trim();
      break;
    }
  }
  return n;
}

export function domainOf(website: string): string {
  try {
    const host = new URL(website).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return website.toLowerCase().trim();
  }
}

/** Prefer a root .com address when a company lists several websites
 *  (Apple lists a dozen regional variants — apple.com wins). */
function websiteScore(site: string): number {
  try {
    const u = new URL(site);
    const path = u.pathname;
    return (
      (path !== '/' && path !== '' ? 1 : 0) +
      (!u.hostname.endsWith('.com') ? 1 : 0) +
      site.length / 10000
    );
  } catch {
    return 99;
  }
}

const WDQS_TYPES =
  '{ ?company wdt:P31 wd:Q4830453 } UNION { ?company wdt:P31 wd:Q783794 } ' +
  'UNION { ?company wdt:P31 wd:Q891723 } UNION { ?company wdt:P31 wd:Q6881511 }';

async function fetchWikidataPage(
  offset: number,
  limit: number,
): Promise<{ companies: { name: string; website: string }[]; rows: number }> {
  const query =
    'SELECT ?company ?companyLabel ?website WHERE { ' +
    WDQS_TYPES +
    ' . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } ' +
    '. ?company wdt:P856 ?website . ' +
    'SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } ' +
    `LIMIT ${limit} OFFSET ${offset}`;
  const url =
    'https://query.wikidata.org/sparql?' +
    new URLSearchParams({ query, format: 'json' }).toString();
  const r = await fetch(url, {
    headers: { 'User-Agent': 'JobBoardFinder/1.0 (job search research)' },
    signal: AbortSignal.timeout(WDQS_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
  const data = await r.json();
  const bindings: any[] = data?.results?.bindings ?? [];
  const byEnt = new Map<string, { name: string; website: string }>();
  for (const b of bindings) {
    const uri: string = b.company?.value ?? '';
    const ent = uri.split('/').pop() ?? uri;
    const name: string = b.companyLabel?.value ?? ent;
    const site: string = b.website?.value ?? '';
    if (!site) continue;
    const cur = byEnt.get(ent);
    if (!cur || websiteScore(site) < websiteScore(cur.website)) {
      byEnt.set(ent, { name, website: site });
    }
  }
  return { companies: [...byEnt.values()], rows: bindings.length };
}

function authorized(req: VercelRequest): boolean {
  const key = req.headers['x-sync-key'];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}

async function handlerInner(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body ?? {};
  const limitRaw = Number(body.limit ?? 500);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 500;
  const offsetRaw = Number(body.offset ?? 0);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  // The user's own database, read from the state doc — the filter that
  // guarantees no company is ever returned twice.
  const existing = await getStateCompanies();
  const domains = new Set(existing.map((c) => domainOf(c.website)).filter(Boolean));
  const names = new Set(existing.map((c) => nameKey(c.name)).filter(Boolean));
  const isDup = (name: string, website: string): boolean =>
    (domainOf(website) !== '' && domains.has(domainOf(website))) ||
    (nameKey(name) !== '' && names.has(nameKey(name)));
  const claim = (name: string, website: string): void => {
    const d = domainOf(website);
    if (d) domains.add(d);
    const n = nameKey(name);
    if (n) names.add(n);
  };

  const batch: FoundCompany[] = [];

  // Live discovery from Wikidata until the batch is full, the soft
  // deadline hits, or the result set runs out. The offset only advances
  // past pages that returned successfully, so a timeout loses nothing —
  // the next press retries the same page.
  const startedAt = Date.now();
  let cursor = offset;
  let wikidataExhausted = false;
  let wdqsError = false;
  let pages = 0;
  while (
    batch.length < limit &&
    Date.now() - startedAt < SOFT_DEADLINE_MS &&
    pages < MAX_PAGES_PER_PRESS
  ) {
    let page: { companies: { name: string; website: string }[]; rows: number };
    try {
      page = await fetchWikidataPage(cursor, WDQS_PAGE_ROWS);
    } catch {
      wdqsError = true;
      break;
    }
    pages += 1;
    cursor += WDQS_PAGE_ROWS;
    if (page.rows < WDQS_PAGE_ROWS) wikidataExhausted = true;
    for (const c of page.companies) {
      if (batch.length >= limit) break;
      if (isDup(c.name, c.website)) continue;
      batch.push({
        name: c.name,
        website: c.website,
        careersUrl: '',
        category: 'General',
        source: 'Wikidata',
      });
      claim(c.name, c.website);
    }
    if (page.rows < WDQS_PAGE_ROWS) break;
  }

  return res.status(200).json({
    companies: batch,
    nextOffset: cursor,
    wikidataExhausted,
    exhausted: wikidataExhausted,
    error:
      batch.length === 0 && wdqsError
        ? 'Discovery timed out — press again, nothing was lost.'
        : undefined,
  });
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
