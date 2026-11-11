/* Shared server helpers for the Finder (Vercel functions).
 *
 * The Finder's company database lives in a dedicated MongoDB collection
 * ('companies' in db 'dealboard'), NOT in the app state doc — the state
 * doc has a ~4.5MB function-payload limit that caps it at tens of
 * thousands of rows, while the collection scales to millions.
 *
 * Dedupe rule (same composite key the client uses): a company is a
 * duplicate when its (normalized name, website domain) pair matches an
 * existing row. Same domain with a different name is a different company;
 * same name with a different domain is a different company. Rows without
 * a website are kept as name-only rows (legacy migration only — every
 * live-discovery source provides a website).
 *
 * Nothing in this module contains company data. Sources are queried live
 * by the Finder functions; this module only stores what the button found.
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

// Vercel provides process.env at runtime; the project has no @types/node.
declare const process: { env: Record<string, string | undefined> };

export interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: any;
}
export interface VercelResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

export function authorized(req: VercelRequest): boolean {
  const key = req.headers['x-sync-key'];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}

export function firstQuery(req: VercelRequest, name: string): string | undefined {
  const v = req.query?.[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/* ------------------------------------------------------------------ */
/* Company docs                                                        */
/* ------------------------------------------------------------------ */

export interface CompanyDoc {
  // any: the driver requires _id to accept ObjectId on insert.
  _id?: any;
  name: string;
  website: string;
  /** Omitted when the row has no website (legacy rows only). */
  domain?: string;
  nameKey: string;
  /** Stable source-side id when the source provides one (Wikidata QID,
   *  EDGAR CIK). Used as a second dedupe key: the same entity found
   *  through two types (or two pages that split its websites) must not
   *  become two rows even if the chosen website differs. */
  sourceId?: string;
  careersUrl: string;
  category: string;
  source: string;
  addedAt: string;
}

export interface CompanyInput {
  name: string;
  website?: string;
  careersUrl?: string;
  category?: string;
  source?: string;
  sourceId?: string;
  addedAt?: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  website: string;
  careersUrl: string;
  category: string;
  source: string;
  addedAt: string;
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

/** Board domains are never a source: a URL on one is skipped outright,
 *  whether the user pasted it or a page links to it. Shared by the
 *  HTML reader and the render fallback (which also refuses to parse a
 *  page that redirected onto a board). */
export function isBoardUrl(url: string): boolean {
  return /greenhouse\.io|lever\.co|ashbyhq\.com|jazz\.co|applytojob\.com/i.test(url);
}

/** Composite dedupe key: normalized name + website domain. */
export function companyPairKey(name: string, website: string): string {
  return `${nameKey(name)}|${domainOf(website)}`;
}

/** Convert a candidate row to a storable doc. Returns null when the row
 *  has no usable name (it is not a company). Rows without a website are
 *  kept as name-only docs (domain omitted) so legacy rows are never lost. */
export function toCompanyDoc(input: CompanyInput): CompanyDoc | null {
  const name = (input.name ?? '').trim();
  if (!name) return null;
  const website = (input.website ?? '').trim();
  const domain = website ? domainOf(website) : '';
  const doc: CompanyDoc = {
    name,
    website,
    nameKey: nameKey(name),
    careersUrl: (input.careersUrl ?? '').trim(),
    category: (input.category ?? '').trim(),
    source: (input.source ?? '').trim(),
    addedAt: input.addedAt ?? new Date().toISOString(),
  };
  if (domain) doc.domain = domain;
  const sourceId = (input.sourceId ?? '').trim();
  if (sourceId) doc.sourceId = sourceId;
  return doc;
}

function toRow(doc: CompanyDoc): CompanyRow {
  return {
    id: String(doc._id ?? ''),
    name: doc.name,
    website: doc.website,
    careersUrl: doc.careersUrl,
    category: doc.category,
    source: doc.source,
    addedAt: doc.addedAt,
  };
}

/* ------------------------------------------------------------------ */
/* MongoDB                                                             */
/* ------------------------------------------------------------------ */

let mongoClient: MongoClient | null = null;
let indexesReady = false;

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  if (!mongoClient) {
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
  }
  return mongoClient.db('dealboard');
}

export async function getCompaniesCollection(): Promise<Collection<CompanyDoc>> {
  const db = await getDb();
  const col = db.collection<CompanyDoc>('companies');
  if (!indexesReady) {
    try {
      // Sparse compound unique: docs without a domain (legacy name-only
      // rows) are indexed on (null, nameKey) and dedupe by name alone.
      await col.createIndex({ domain: 1, nameKey: 1 }, { unique: true, sparse: true });
      await col.createIndex({ domain: 1 });
      await col.createIndex({ nameKey: 1 });
      await col.createIndex({ addedAt: 1 });
    } catch {
      // Indexes may already exist or race with another cold start — the
      // unique constraint is enforced by the database either way.
    }
    indexesReady = true;
  }
  return col;
}

export interface ExistingKeys {
  pairs: Set<string>;
  sourceIds: Set<string>;
}

/** One query for a whole batch: which (nameKey, domain) pairs and which
 *  source ids are already stored? Lookup is a wide OR net; the exact
 *  composite match (or source-id match) decides. */
export async function findExistingPairs(
  col: Collection<CompanyDoc>,
  docs: CompanyDoc[],
): Promise<ExistingKeys> {
  const pairs = new Set<string>();
  const sourceIds = new Set<string>();
  const domains = [...new Set(docs.map((d) => d.domain).filter((d): d is string => !!d))];
  const nameKeys = [...new Set(docs.map((d) => d.nameKey).filter(Boolean))];
  const qids = [...new Set(docs.map((d) => d.sourceId).filter((s): s is string => !!s))];
  if (domains.length === 0 && nameKeys.length === 0 && qids.length === 0) {
    return { pairs, sourceIds };
  }
  const or: Record<string, unknown>[] = [];
  if (domains.length > 0) or.push({ domain: { $in: domains } });
  if (nameKeys.length > 0) or.push({ nameKey: { $in: nameKeys } });
  if (qids.length > 0) or.push({ sourceId: { $in: qids } });
  const found = await col
    .find({ $or: or } as never)
    .project({ domain: 1, nameKey: 1, sourceId: 1 } as never)
    .toArray();
  for (const f of found as unknown as { domain?: string; nameKey?: string; sourceId?: string }[]) {
    pairs.add(`${f.nameKey ?? ''}|${f.domain ?? ''}`);
    if (f.sourceId) sourceIds.add(f.sourceId);
  }
  return { pairs, sourceIds };
}

/** Split candidate docs into new vs already-stored (composite key, or
 *  source-id match for sources that provide stable ids). Skipped docs
 *  are returned too, so callers can upgrade them (a stored social URL
 *  gives way to a real website for the same company). */
export function splitNew(
  docs: CompanyDoc[],
  existing: ExistingKeys,
): { fresh: CompanyDoc[]; skipped: number; skippedDocs: CompanyDoc[] } {
  const fresh: CompanyDoc[] = [];
  const skippedDocs: CompanyDoc[] = [];
  let skipped = 0;
  for (const d of docs) {
    const key = `${d.nameKey}|${d.domain ?? ''}`;
    if (existing.pairs.has(key) || (d.sourceId && existing.sourceIds.has(d.sourceId))) {
      skipped += 1;
      skippedDocs.push(d);
      continue;
    }
    existing.pairs.add(key);
    if (d.sourceId) existing.sourceIds.add(d.sourceId);
    fresh.push(d);
  }
  return { fresh, skipped, skippedDocs };
}

/** Social platforms whose profile URLs count as online presence but are
 *  fallback links only — a real website always beats one of these. */
export const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'instagram.com',
  'www.instagram.com',
  'linkedin.com',
  'www.linkedin.com',
  'youtube.com',
  'www.youtube.com',
  'tiktok.com',
  'www.tiktok.com',
]);

export function isSocialUrl(site: string | undefined): boolean {
  if (!site) return false;
  try {
    return SOCIAL_HOSTS.has(new URL(site).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Upgrade a stored row's link: when a company already in the collection
 *  (matched by stable source id) only has a social profile URL, and a
 *  later source provides its real website, replace the link. Never
 *  downgrades a real website to a social URL, and never touches rows
 *  without a matching source id. Returns 1 when an upgrade landed. */
export async function upgradeWebsite(
  col: Collection<CompanyDoc>,
  doc: CompanyDoc,
): Promise<number> {
  if (!doc.sourceId || !doc.website || isSocialUrl(doc.website)) return 0;
  const existing = await col.findOne({ sourceId: doc.sourceId } as never);
  if (!existing || !isSocialUrl(existing.website)) return 0;
  // Collision guard (2026-11-03: this bricked Find Companies at ~11.7k
  // companies): the same business may already have a real-website row
  // under a DIFFERENT source id (Wikidata duplicates). Upgrading this
  // social row into that row's exact (domain, nameKey) pair violates
  // the unique index, throws out of the press, and — because the
  // cursor never advances past a throwing page — bricks every later
  // press on the same page. Skip instead: the real-website row already
  // covers the business.
  const clash = await col.findOne({
    domain: doc.domain,
    nameKey: (existing as CompanyDoc).nameKey,
  } as never);
  if (clash && String((clash as CompanyDoc)._id) !== String((existing as CompanyDoc)._id)) {
    return 0;
  }
  try {
    await col.updateOne(
      { _id: (existing as CompanyDoc)._id } as never,
      { $set: { website: doc.website, domain: doc.domain } } as never,
    );
  } catch (e) {
    // Race: another press inserted the pair first — same skip.
    if ((e as { code?: number })?.code === 11000) return 0;
    throw e;
  }
  return 1;
}

/** Insert docs, tolerating duplicate-key errors (races / replays).
 *  Any non-duplicate write error is rethrown. */
export async function insertCompanies(
  col: Collection<CompanyDoc>,
  docs: CompanyDoc[],
): Promise<number> {
  if (docs.length === 0) return 0;
  try {
    const r = await col.insertMany(docs, { ordered: false });
    return r.insertedCount;
  } catch (e: unknown) {
    const err = e as {
      result?: { insertedCount?: number };
      insertedCount?: number;
      writeErrors?: { code?: number }[];
    };
    const nonDup = (err.writeErrors ?? []).filter((we) => we?.code !== 11000);
    if (nonDup.length > 0) throw e;
    const inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
    return typeof inserted === 'number' ? inserted : 0;
  }
}

/** Convert + dedupe + insert a batch of candidate rows. */
export async function addCompanies(
  col: Collection<CompanyDoc>,
  inputs: CompanyInput[],
): Promise<{ inserted: number; skipped: number; invalid: number }> {
  const docs: CompanyDoc[] = [];
  let invalid = 0;
  for (const input of inputs) {
    const doc = toCompanyDoc(input);
    if (!doc) invalid += 1;
    else docs.push(doc);
  }
  const existing = await findExistingPairs(col, docs);
  const { fresh, skipped } = splitNew(docs, existing);
  const inserted = await insertCompanies(col, fresh);
  return { inserted, skipped: skipped + (fresh.length - inserted), invalid };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Server-paged company list for the client table + search. */
export async function listCompanies(
  col: Collection<CompanyDoc>,
  opts: { skip: number; limit: number; q: string },
): Promise<{ companies: CompanyRow[]; total: number; skip: number; limit: number }> {
  const skip = Number.isFinite(opts.skip) && opts.skip >= 0 ? Math.floor(opts.skip) : 0;
  const limit = Number.isFinite(opts.limit)
    ? Math.min(100, Math.max(1, Math.floor(opts.limit)))
    : 25;
  const filter: Record<string, unknown> = {};
  const q = (opts.q ?? '').trim();
  if (q) {
    const rx = { $regex: escapeRegExp(q), $options: 'i' };
    filter.$or = [{ name: rx }, { website: rx }, { category: rx }];
  }
  const total = await col.countDocuments(filter as never);
  const docs = await col
    .find(filter as never)
    .sort({ name: 1 } as never)
    .skip(skip)
    .limit(limit)
    .toArray();
  return { companies: docs.map(toRow), total, skip, limit };
}

/* ------------------------------------------------------------------ */
/* Finder cursor (server-side, survives lost client state)             */
/* ------------------------------------------------------------------ */

export interface FinderCursor {
  version: number;
  sourceIndex: number;
  state: Record<string, Record<string, unknown>>;
  /** Companies already fetched from a page but not yet inserted because
   *  an earlier call hit its exact limit. The next call drains these
   *  first, so no fetched company is ever lost or skipped — this is what
   *  makes an exact per-press count possible despite page-granular
   *  source pages. */
  pending?: CompanyInput[];
}

/** finder_meta doc: the Finder's persistent server-side cursor. */
export interface FinderMetaDoc {
  _id: string;
  version?: number;
  sourceIndex?: number;
  state?: Record<string, Record<string, unknown>>;
  pending?: CompanyInput[];
  updatedAt?: Date;
}

/** app_state doc (only the fields migration touches). */
export interface AppStateDoc {
  _id: string;
  state?: { companies?: unknown };
  updatedAt?: Date;
}

export async function getFinderCursor(meta: Collection<FinderMetaDoc>): Promise<FinderCursor> {
  const doc = await meta.findOne({ _id: 'find-companies' });
  if (!doc) return { version: 0, sourceIndex: 0, state: {}, pending: [] };
  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    sourceIndex: typeof doc.sourceIndex === 'number' ? doc.sourceIndex : 0,
    state: doc.state ?? {},
    pending: Array.isArray(doc.pending) ? doc.pending : [],
  };
}

export async function saveFinderCursor(
  meta: Collection<FinderMetaDoc>,
  cursor: FinderCursor,
): Promise<void> {
  await meta.updateOne(
    { _id: 'find-companies' },
    { $set: { ...cursor, updatedAt: new Date() } },
    { upsert: true },
  );
}

/* ------------------------------------------------------------------ */
/* Migration: state-doc companies -> collection (legacy safety net)    */
/* ------------------------------------------------------------------ */

export async function migrateStateCompanies(
  companiesCol: Collection<CompanyDoc>,
  appStateCol: Collection<AppStateDoc>,
): Promise<{ moved: number; skipped: number; invalid: number; cleared: boolean }> {
  const doc = await appStateCol.findOne({ _id: 'jobboard' });
  const list = doc?.state?.companies;
  if (!Array.isArray(list) || list.length === 0) {
    return { moved: 0, skipped: 0, invalid: 0, cleared: false };
  }
  const inputs: CompanyInput[] = list.map((c) => {
    const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    return {
      name: String(o.name ?? ''),
      website: String(o.website ?? ''),
      careersUrl: String(o.careersUrl ?? ''),
      category: String(o.category ?? ''),
      source: String(o.source ?? ''),
      addedAt: typeof o.addedAt === 'string' ? o.addedAt : undefined,
    };
  });
  const result = await addCompanies(companiesCol, inputs);
  // Clear the state-doc list ONLY when every row was placed or was a
  // duplicate — a row that could not be converted (no name) stays put
  // rather than being silently lost.
  const cleared = result.invalid === 0;
  if (cleared) {
    await appStateCol.updateOne(
      { _id: 'jobboard' },
      { $set: { 'state.companies': [] } },
    );
  }
  return { moved: result.inserted, skipped: result.skipped, invalid: result.invalid, cleared };
}
