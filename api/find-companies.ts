/* Finder company discovery — Vercel serverless function.
 *
 * Every press returns NEW companies the button discovered LIVE from
 * public sources — never a pre-compiled list, never a seed, never a
 * repeat. The button walks a sequence of live sources behind ONE
 * server-side cursor (stored in MongoDB, so lost client state cannot
 * repeat or skip anything):
 *
 *   1. Wikidata — US companies with official websites (country or
 *      headquarters in the US), one independent OFFSET cursor per
 *      entity type (business, company, public company, enterprise).
 *      Per-type cursors outlive the old combined query's deep-OFFSET
 *      slowdown by 2-4x. Rows carry their Wikidata QID as sourceId, so
 *      the same entity found through two types (or two pages that split
 *      its websites) dedupes to one row.
 *   2. SEC EDGAR — US public filers with websites, walked by a
 *      server-side index into the live ticker map (sorted by CIK, so
 *      the cursor stays stable as the map grows). Each entry's
 *      submissions JSON is fetched live; only rows with a website and a
 *      US state (incorporation or business address) are kept.
 *
 * More live sources plug into SOURCES below with the same contract:
 * fetchPage(state, budgetMs, fetch) -> {companies, nextState, exhausted}.
 * A source's page is banked into the collection immediately (dedupe by
 * the (name, domain) composite key, or by source id when the source
 * provides one) and the cursor advances past it, so a press that runs
 * out of time still keeps its progress.
 *
 * A press never returns 0 while sources remain, except for a transient
 * source error — in which case the cursor does NOT advance past the
 * failed page and the response carries a retry-safe message. After 3
 * consecutive failures a source is SKIPPED (the button must never brick
 * on a dead source) and the press continues with the next source; the
 * skip is reported in the response note. A stretch that yields only
 * already-known companies still advances the cursor, so repeated
 * presses always move forward.
 *
 * Hard platform budget: the function must answer within ~60s, so the
 * whole press runs under a 55s budget and no single fetch may run past
 * the remaining budget. Partial batches are successes.
 *
 * Exact counts: inserts are capped at the requested limit per call.
 * Any excess from a fetched page is banked in the cursor's pending
 * buffer and drained first on the next call, so repeated calls converge
 * exactly on a requested count without ever losing or repeating a
 * company — a page-granular source can never overshoot a press.
 *
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY. Nothing here
 * takes a URL from the client; every row comes from a public source
 * queried live at press time.
 */

import {
  addCompanies,
  authorized,
  findExistingPairs,
  getCompaniesCollection,
  getDb,
  getFinderCursor,
  insertCompanies,
  saveFinderCursor,
  splitNew,
  toCompanyDoc,
  type CompanyDoc,
  type CompanyInput,
  type FinderCursor,
  type FinderMetaDoc,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';
import type { Collection } from 'mongodb';

// Vercel provides process.env at runtime; the project has no @types/node.
declare const process: { env: Record<string, string | undefined> };

/** Bump whenever a source adapter changes its cursor-state shape — a
 *  stored cursor from an older shape is discarded, never misread.
 *  v1 = combined Wikidata query; v2 = per-type Wikidata + SEC EDGAR. */
const SOURCES_VERSION = 2;

const FUNCTION_BUDGET_MS = 55000;
const WDQS_TIMEOUT_MS = 45000;
const WDQS_PAGE_ROWS = 300;
const MAX_BATCH = 2000;

interface SourcePage {
  companies: CompanyInput[];
  nextState: Record<string, unknown>;
  exhausted: boolean;
}

interface SourceAdapter {
  key: string;
  label: string;
  fetchPage: (
    state: Record<string, unknown>,
    budgetMs: number,
    fetchFn: typeof fetch,
  ) => Promise<SourcePage>;
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

/** One independent OFFSET cursor per entity type. A combined query hits
 *  deep-OFFSET slowdown once; per-type queries spread the same rows over
 *  four shallower cursors, so the button lives 2-4x longer on Wikidata
 *  before any type degrades. */
const WDQS_TYPE_IDS = ['Q4830453', 'Q783794', 'Q891723', 'Q6881511'];

const wikidataAdapter: SourceAdapter = {
  key: 'wikidata',
  label: 'Wikidata',
  async fetchPage(state, budgetMs, fetchFn): Promise<SourcePage> {
    const typeIndex =
      typeof state.typeIndex === 'number' &&
      state.typeIndex >= 0 &&
      state.typeIndex < WDQS_TYPE_IDS.length
        ? state.typeIndex
        : 0;
    const offsets = (Array.isArray(state.offsets) ? state.offsets : []).map((o) =>
      typeof o === 'number' && o >= 0 ? o : 0,
    );
    while (offsets.length < WDQS_TYPE_IDS.length) offsets.push(0);
    const offset = offsets[typeIndex];
    const type = WDQS_TYPE_IDS[typeIndex];
    const query =
      'SELECT ?company ?companyLabel ?website WHERE { ' +
      `?company wdt:P31 wd:${type} . ` +
      '{ ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } ' +
      '. ?company wdt:P856 ?website . ' +
      'SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } ' +
      `LIMIT ${WDQS_PAGE_ROWS} OFFSET ${offset}`;
    const url =
      'https://query.wikidata.org/sparql?' +
      new URLSearchParams({ query, format: 'json' }).toString();
    const r = await fetchFn(url, {
      headers: { 'User-Agent': 'JobBoardFinder/1.0 (job search research)' },
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings: unknown[] = (data as { results?: { bindings?: unknown[] } })?.results
      ?.bindings ?? [];
    const byEnt = new Map<string, { name: string; website: string }>();
    for (const b of bindings as {
      company?: { value?: string };
      companyLabel?: { value?: string };
      website?: { value?: string };
    }[]) {
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
    const nextOffsets = [...offsets];
    nextOffsets[typeIndex] = offset + WDQS_PAGE_ROWS;
    const typeExhausted = bindings.length < WDQS_PAGE_ROWS;
    const nextTypeIndex = typeExhausted ? typeIndex + 1 : typeIndex;
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: '',
        category: 'General',
        source: 'Wikidata',
        sourceId: qid,
      })),
      nextState: { typeIndex: nextTypeIndex, offsets: nextOffsets },
      exhausted: nextTypeIndex >= WDQS_TYPE_IDS.length,
    };
  },
};

/* ------------------------------------------------------------------ */
/* SEC EDGAR — US public filers with websites                          */
/* ------------------------------------------------------------------ */

// SEC fair-access policy: stay under 10 req/sec and declare a contact
// User-Agent. The contact below is the user's public business address;
// change it if a different contact is preferred.
const SEC_USER_AGENT = 'JobBoardFinder/1.0 (job search research; ericcapiz@gmail.com)';
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);
const EDGAR_WAVE_SIZE = 25;
const EDGAR_CONCURRENCY = 5;
const EDGAR_FETCH_TIMEOUT_MS = 15000;
const EDGAR_TICKER_CACHE_MS = 60000;

interface TickerEntry {
  cik: number;
  ticker: string;
  title: string;
}

// The ticker map changes slowly (regenerated, not live-edited), so a
// 60s cache means one map fetch per press in practice — submissions are
// always fetched fresh per entry.
let tickerMapCache: { at: number; entries: TickerEntry[] } | null = null;

async function fetchTickerMap(
  fetchFn: typeof fetch,
  nowMs: number,
  budgetMs: number,
): Promise<TickerEntry[]> {
  if (tickerMapCache && nowMs - tickerMapCache.at < EDGAR_TICKER_CACHE_MS) {
    return tickerMapCache.entries;
  }
  const r = await fetchFn('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_USER_AGENT },
    signal: AbortSignal.timeout(Math.min(15000, budgetMs)),
  });
  if (!r.ok) throw new Error(`SEC ticker map HTTP ${r.status}`);
  const data = await r.json();
  const values: unknown[] = Array.isArray(data)
    ? data
    : Object.values(data as Record<string, unknown>);
  const entries: TickerEntry[] = [];
  for (const v of values) {
    const o = v as { cik_str?: unknown; ticker?: unknown; title?: unknown };
    const cik = Number(o.cik_str);
    if (!Number.isFinite(cik) || cik <= 0) continue;
    entries.push({
      cik: Math.floor(cik),
      ticker: String(o.ticker ?? ''),
      title: String(o.title ?? ''),
    });
  }
  // Sorted by CIK, not file order: the file's order can change between
  // fetches, but CIK order is stable, so the cursor never skips or
  // repeats entries when the map is refreshed (new filers get high CIKs
  // and sort after the cursor).
  entries.sort((a, b) => a.cik - b.cik);
  tickerMapCache = { at: nowMs, entries };
  return entries;
}

const edgarAdapter: SourceAdapter = {
  key: 'edgar',
  label: 'SEC EDGAR',
  async fetchPage(state, budgetMs, fetchFn): Promise<SourcePage> {
    const tickerIndex =
      typeof state.tickerIndex === 'number' && state.tickerIndex >= 0 ? state.tickerIndex : 0;
    const startedAt = Date.now();
    const entries = await fetchTickerMap(fetchFn, startedAt, budgetMs);
    const wave = entries.slice(tickerIndex, tickerIndex + EDGAR_WAVE_SIZE);
    if (wave.length === 0) {
      return { companies: [], nextState: { tickerIndex }, exhausted: true };
    }
    const companies: CompanyInput[] = [];
    let claimed = 0;
    async function worker(): Promise<void> {
      while (claimed < wave.length) {
        const remaining = budgetMs - (Date.now() - startedAt);
        if (remaining < 3000) return;
        const entry = wave[claimed];
        claimed += 1;
        // Stagger starts so aggregate rate stays under SEC's 10 req/sec
        // (5 workers x ~1s fetches).
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const cikPad = String(entry.cik).padStart(10, '0');
          const fetchRemaining = budgetMs - (Date.now() - startedAt);
          const r = await fetchFn(`https://data.sec.gov/submissions/CIK${cikPad}.json`, {
            headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(
              Math.min(EDGAR_FETCH_TIMEOUT_MS, Math.max(3000, fetchRemaining)),
            ),
          });
          if (!r.ok) continue; // Unreadable entry: skipped, cursor advances.
          const data = (await r.json()) as Record<string, unknown>;
          const website = String(data.website ?? '').trim();
          if (!website) continue;
          const incorp = String(data.stateOfIncorporation ?? '').toUpperCase();
          const addresses = data.addresses as
            | { business?: { stateOrCountry?: unknown } }
            | undefined;
          const bizState = String(addresses?.business?.stateOrCountry ?? '').toUpperCase();
          if (!US_STATE_CODES.has(incorp) && !US_STATE_CODES.has(bizState)) continue;
          const name = String(data.name ?? '').trim() || entry.title;
          if (!name) continue;
          companies.push({
            name,
            website,
            careersUrl: '',
            category: 'Public company',
            source: 'SEC EDGAR',
            sourceId: `CIK${cikPad}`,
          });
        } catch {
          // Unreadable entry: skipped, cursor advances past it.
          continue;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(EDGAR_CONCURRENCY, wave.length) }, () => worker()),
    );
    // Advance only past CLAIMED entries: unclaimed wave entries (cut off
    // by the budget) are retried next press, never lost.
    return {
      companies,
      nextState: { tickerIndex: tickerIndex + claimed },
      exhausted: tickerIndex + claimed >= entries.length,
    };
  },
};

/** Live sources, in the order the button walks them. */
const SOURCES: SourceAdapter[] = [wikidataAdapter, edgarAdapter];

export interface FindCompaniesDeps {
  companiesCol: Collection<CompanyDoc>;
  metaCol: Collection<FinderMetaDoc>;
  fetchFn: typeof fetch;
  now?: () => number;
}

export interface FindCompaniesResult {
  added: number;
  total: number;
  source: string;
  exhausted: boolean;
  error?: string;
  note?: string;
}

export async function runFindCompanies(
  deps: FindCompaniesDeps,
  body: { limit?: number },
): Promise<FindCompaniesResult> {
  const limitRaw = Number(body.limit ?? MAX_BATCH);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_BATCH, Math.max(1, Math.floor(limitRaw)))
    : MAX_BATCH;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  let cursor: FinderCursor = await getFinderCursor(deps.metaCol);
  if (cursor.version !== SOURCES_VERSION) {
    cursor = { version: SOURCES_VERSION, sourceIndex: 0, state: {}, pending: [] };
    await saveFinderCursor(deps.metaCol, cursor);
  }
  cursor.pending ??= [];

  let added = 0;
  let source = '';
  let transientError = false;
  let advancedPastWork = false;
  let skipNote: string | undefined;

  // Drain companies banked by an earlier call that hit its exact limit.
  // These go first, so no fetched company is ever lost or skipped.
  if (cursor.pending.length > 0 && added < limit) {
    const take = cursor.pending.slice(0, limit - added);
    const drained = await addCompanies(deps.companiesCol, take);
    added += drained.inserted;
    cursor.pending = cursor.pending.slice(take.length);
    advancedPastWork = true;
    await saveFinderCursor(deps.metaCol, cursor);
  }

  while (added < limit && cursor.sourceIndex < SOURCES.length) {
    const remaining = FUNCTION_BUDGET_MS - (now() - startedAt);
    if (remaining < 10000) break;
    const adapter = SOURCES[cursor.sourceIndex];
    source = adapter.label;
    const subState = cursor.state[adapter.key] ?? {};
    let page: SourcePage;
    try {
      page = await adapter.fetchPage(subState, Math.min(WDQS_TIMEOUT_MS, remaining), deps.fetchFn);
    } catch {
      // Transient failure: count it. After 3 consecutive failures the
      // source is SKIPPED (the button must never brick on a dead source)
      // and the press continues with the next source; before that, the
      // cursor does NOT advance past the failed page, so the next press
      // retries exactly it. Nothing is lost either way.
      const failures = (typeof subState.failures === 'number' ? subState.failures : 0) + 1;
      if (failures >= 3) {
        cursor.state[adapter.key] = { ...subState, failures: 0 };
        cursor.sourceIndex += 1;
        await saveFinderCursor(deps.metaCol, cursor);
        skipNote = `${adapter.label} is temporarily unavailable and was skipped — continuing with the next source.`;
        continue;
      }
      cursor.state[adapter.key] = { ...subState, failures };
      await saveFinderCursor(deps.metaCol, cursor);
      transientError = true;
      break;
    }
    // Cap inserts at this call's remaining limit: take only what the
    // call still needs, bank the rest into pending for the next call.
    // Dedupe covers the collection AND pending, so a company banked
    // earlier is never re-added from a later page of another type.
    const docs: CompanyDoc[] = [];
    for (const input of page.companies) {
      const doc = toCompanyDoc(input);
      if (doc) docs.push(doc);
    }
    const existing = await findExistingPairs(deps.companiesCol, docs);
    for (const p of cursor.pending) {
      const d = toCompanyDoc(p);
      if (!d) continue;
      existing.pairs.add(`${d.nameKey}|${d.domain ?? ''}`);
      if (d.sourceId) existing.sourceIds.add(d.sourceId);
    }
    const { fresh } = splitNew(docs, existing);
    const take = fresh.slice(0, limit - added);
    const rest = fresh.slice(limit - added);
    const inserted = await insertCompanies(deps.companiesCol, take);
    added += inserted;
    advancedPastWork = true;
    cursor.pending = [
      ...cursor.pending,
      ...rest.map((d) => ({
        name: d.name,
        website: d.website,
        careersUrl: d.careersUrl,
        category: d.category,
        source: d.source,
        sourceId: d.sourceId,
      })),
    ];
    cursor.state[adapter.key] = { ...page.nextState, failures: 0 };
    if (page.exhausted) cursor.sourceIndex += 1;
    await saveFinderCursor(deps.metaCol, cursor);
  }

  const total = await deps.companiesCol.countDocuments();
  const exhausted = cursor.sourceIndex >= SOURCES.length;
  if (added === 0 && transientError) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      error: 'Discovery hit a snag — press again, nothing was lost.',
    };
  }
  if (added === 0 && advancedPastWork) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      note:
        skipNote ??
        'Everything in this stretch was already in your database — press again to keep going.',
    };
  }
  if (added === 0 && !transientError && !advancedPastWork && !exhausted) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      error: 'Discovery hit a snag — press again, nothing was lost.',
    };
  }
  return { added, total, source, exhausted, note: skipNote };
}

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
  const db = await getDb();
  const result = await runFindCompanies(
    {
      companiesCol: await getCompaniesCollection(),
      metaCol: db.collection<FinderMetaDoc>('finder_meta'),
      fetchFn: fetch,
    },
    { limit: body.limit },
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
