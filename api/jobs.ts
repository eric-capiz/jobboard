// GET /api/jobs — public read-only board snapshot. No auth.
//
// Data flow (see RENDER-PLAN.md): the GitHub Actions ingest merge job
// commits data/jobs.json; this endpoint serves it.
//
//   Primary:  GET https://raw.githubusercontent.com/eric-capiz/jobboard/main/data/jobs.json
//             10-minute in-memory cache, stale-while-revalidate: a
//             request served from cache never waits on GitHub; a
//             background refresh updates the cache.
//   Fallback: the copy of data/jobs.json shipped inside the deployment
//             itself (Dockerfile.service copies it into the image).
//             Used only when GitHub is unreachable; the response carries
//             source: 'bundled' so the UI can say the copy is stale.
//   Defense in depth: jobs are re-filtered server-side before every
//   response, so a stale or hand-edited snapshot cannot surface an
//   expired job. The snapshot carries no verification_expires_at
//   column, so the 14-day re-verify cycle is enforced from
//   last_verified_at (the merge job writes verification_expires_at =
//   last_verified_at + 14 days, and a re-verify refreshes both
//   together, so the two rules agree).
//
// Response: { generatedAt, counts, liveJobs, jobs, source } where jobs
// are the listLiveJobs rows (id, company_id, title, canonical_url,
// location, description_excerpt, first_seen, last_verified_at).
// When neither GitHub nor the bundled copy is available: 503.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal Vercel serverless function types (avoids @vercel/node dependency).
interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
}
interface VercelResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

const RAW_URL =
  'https://raw.githubusercontent.com/eric-capiz/jobboard/main/data/jobs.json';

/** Snapshot cache lifetime: the ingest merge job commits every 30 min,
 *  so a 10-minute cache is always at most one commit behind. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Re-verify cycle (src/db.cjs): a job stays live 14 days from its
 *  last verification. */
const VERIFY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** GitHub fetch timeout — a slow upstream must never hang the board. */
const FETCH_TIMEOUT_MS = 10 * 1000;

interface PublicJob {
  id: string;
  company_id: string;
  title: string;
  canonical_url: string;
  location: string | null;
  description_excerpt: string;
  first_seen: string;
  last_verified_at: string;
}

interface SnapshotCounts {
  companies: number;
  live: number;
  rejected: number;
  verifications: number;
}

interface Snapshot {
  generatedAt: string;
  counts: SnapshotCounts;
  liveJobs: number;
  jobs: PublicJob[];
}

type Source = 'github' | 'bundled' | 'cache';

const cache: { snapshot: Snapshot | null; fetchedAt: number; refreshing: Promise<void> | null } = {
  snapshot: null,
  fetchedAt: 0,
  refreshing: null,
};

/** Parse a timestamp the ingest pipeline wrote. SQLite stores
 *  'YYYY-MM-DD HH:MM:SS' (UTC); normalise it to ISO before parsing so
 *  it is read as UTC, not local time. ISO strings pass through. */
function parseTs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const s = value.trim();
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(s);
  if (sqlite) return Date.parse(`${sqlite[1]}T${sqlite[2]}Z`);
  return Date.parse(s);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate the shape the merge job writes. Anything else is treated
 *  as a failed fetch, never served. */
function asSnapshot(v: unknown): Snapshot | null {
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.jobs)) return null;
  const counts = isRecord(v.counts)
    ? {
        companies: Number(v.counts.companies ?? 0) || 0,
        live: Number(v.counts.live ?? 0) || 0,
        rejected: Number(v.counts.rejected ?? 0) || 0,
        verifications: Number(v.counts.verifications ?? 0) || 0,
      }
    : { companies: 0, live: 0, rejected: 0, verifications: 0 };
  const jobs: PublicJob[] = [];
  for (const raw of v.jobs as unknown[]) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
    if (typeof raw.canonical_url !== 'string' || !raw.canonical_url) continue;
    jobs.push({
      id: raw.id,
      company_id: typeof raw.company_id === 'string' ? raw.company_id : '',
      title: raw.title,
      canonical_url: raw.canonical_url,
      location: typeof raw.location === 'string' ? raw.location : null,
      description_excerpt: typeof raw.description_excerpt === 'string' ? raw.description_excerpt : '',
      first_seen: typeof raw.first_seen === 'string' ? raw.first_seen : '',
      last_verified_at: typeof raw.last_verified_at === 'string' ? raw.last_verified_at : '',
    });
  }
  return {
    generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : new Date(0).toISOString(),
    counts,
    liveJobs: jobs.length,
    jobs,
  };
}

/** Server-side re-filter: a job is servable only while its last
 *  verification is inside the 14-day cycle. Evaluated against now()
 *  on every response, so a cached snapshot ages out correctly. */
function liveJobs(snapshot: Snapshot, now: number): PublicJob[] {
  return snapshot.jobs.filter((job) => {
    const verifiedAt = parseTs(job.last_verified_at);
    return !Number.isNaN(verifiedAt) && now - verifiedAt < VERIFY_TTL_MS;
  });
}

async function fetchRemote(): Promise<Snapshot> {
  const res = await fetch(RAW_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`github snapshot fetch failed: ${res.status}`);
  const snapshot = asSnapshot(await res.json());
  if (!snapshot) throw new Error('github snapshot has an unexpected shape');
  return snapshot;
}

/** Bundled copy search order: explicit env override, then the source
 *  tree layout (api/jobs.ts -> repo root), then the esbuild bundle
 *  layout (cloud-run/server/dist-server/server.mjs -> repo root),
 *  then the working directory. First readable, valid copy wins. */
function readBundled(): Snapshot | null {
  const candidates: string[] = [];
  if (process.env.JOBS_SNAPSHOT_PATH) candidates.push(process.env.JOBS_SNAPSHOT_PATH);
  try {
    candidates.push(fileURLToPath(new URL('../data/jobs.json', import.meta.url)));
    candidates.push(fileURLToPath(new URL('../../../data/jobs.json', import.meta.url)));
  } catch {
    // import.meta.url unavailable — fall through to cwd below.
  }
  candidates.push(path.join(process.cwd(), 'data', 'jobs.json'));
  for (const file of candidates) {
    try {
      const snapshot = asSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (snapshot) return snapshot;
    } catch {
      // Missing or unparsable — try the next candidate.
    }
  }
  return null;
}

function refreshInBackground(): void {
  if (cache.refreshing) return;
  cache.refreshing = (async () => {
    try {
      const snapshot = await fetchRemote();
      cache.snapshot = snapshot;
      cache.fetchedAt = Date.now();
    } catch (e) {
      // Stale cache stays in place; the next request retries.
      console.error('[api/jobs] background refresh failed:', e instanceof Error ? e.message : e);
    } finally {
      cache.refreshing = null;
    }
  })();
}

function respond(res: VercelResponse, snapshot: Snapshot, source: Source): void {
  const now = Date.now();
  const jobs = liveJobs(snapshot, now);
  res.status(200).json({
    generatedAt: snapshot.generatedAt,
    counts: snapshot.counts,
    liveJobs: jobs.length,
    jobs,
    source,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const now = Date.now();

  // Fresh cache: serve it immediately, no GitHub wait.
  if (cache.snapshot && now - cache.fetchedAt < CACHE_TTL_MS) {
    return respond(res, cache.snapshot, 'cache');
  }

  // Stale cache: serve it now, refresh in the background.
  if (cache.snapshot) {
    refreshInBackground();
    return respond(res, cache.snapshot, 'cache');
  }

  // No cache yet: fetch live, fall back to the bundled copy.
  try {
    const snapshot = await fetchRemote();
    cache.snapshot = snapshot;
    cache.fetchedAt = Date.now();
    return respond(res, snapshot, 'github');
  } catch {
    const bundled = readBundled();
    if (bundled) return respond(res, bundled, 'bundled');
    return res.status(503).json({ error: 'jobs snapshot unavailable' });
  }
}
