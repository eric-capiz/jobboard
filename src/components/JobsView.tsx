import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { Badge, Button, EmptyState, Input, Select } from './ui';

/* Browse — the public board of verified remote US jobs, as a search
 * engine (hiring.cafe-style) over the verified index, not just a table.
 *
 * Source is GET /api/jobs (the GitHub Actions ingest snapshot), NOT
 * the state API's job list. The state API still owns Eric's pipeline
 * (Pipeline tab, JobDrawer) and is untouched here. The only merge
 * point: when a public job's canonical_url matches a pipeline job's
 * applyUrl, the row shows that job's pipeline stage (Applied,
 * Interview, ...) so it is never listed as if it were unapplied and
 * never duplicated into the store.
 *
 * Search uses ONLY fields the snapshot actually has: title,
 * company_id, location, description_excerpt, first_seen,
 * last_verified_at. There is no salary filter — the snapshot carries
 * no salary. */

const PAGE_SIZE = 10;

type SortKey = 'newest' | 'title';

/** One row of the listLiveJobs snapshot (see src/db.cjs). */
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

interface JobsResponse {
  generatedAt: string;
  counts: { companies: number; live: number; rejected: number; verifications: number };
  liveJobs: number;
  jobs: PublicJob[];
  source: 'github' | 'bundled' | 'cache';
}

function shortDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const t = Number.isNaN(d.getTime()) ? new Date(iso) : d;
  return Number.isNaN(t.getTime())
    ? '—'
    : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fullDate(iso: string): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/** Parse a timestamp the ingest pipeline wrote. SQLite stores
 *  'YYYY-MM-DD HH:MM:SS' (UTC); ISO strings pass through. Undated
 *  rows return 0 so they sink to the bottom of a newest-first sort. */
function parseTs(iso: string): number {
  if (!iso) return 0;
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const fallback = new Date(iso);
  return Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

/** company_id is the employer's domain (see src/build-companies.cjs);
 *  show it as-is — it is the identifier, not a guess at a display name. */
function displayCompany(companyId: string): string {
  return (companyId || '').replace(/^www\./i, '') || '—';
}

/** The location the table shows: the posting's location, or 'Remote'
 *  when the snapshot carries none. The location filter uses this same
 *  value so the dropdown always matches what the rows display. */
function displayLocation(job: PublicJob): string {
  return job.location || 'Remote';
}

/** Normalise a posting URL for the applied-match: case, scheme, www,
 *  query, hash and trailing slash are all noise for identity here. */
function normalizeUrl(raw: string): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
}

export interface JobSearch {
  query: string;
  company: string;
  location: string;
}

/** Keyword search (case-insensitive substring across title,
 *  company_id and description_excerpt) ANDed with the company and
 *  location filters. Empty query / 'all' filters match everything. */
export function filterJobs(jobs: PublicJob[], search: JobSearch): PublicJob[] {
  const q = search.query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (search.company && job.company_id !== search.company) return false;
    if (search.location && displayLocation(job) !== search.location) return false;
    if (!q) return true;
    return (
      job.title.toLowerCase().includes(q) ||
      job.company_id.toLowerCase().includes(q) ||
      (job.description_excerpt || '').toLowerCase().includes(q)
    );
  });
}

/** Sort a filtered list. 'newest' = last_verified_at desc (default);
 *  'title' = title A–Z. Never mutates the input. */
export function sortJobs(jobs: PublicJob[], sort: SortKey): PublicJob[] {
  const copy = [...jobs];
  if (sort === 'title') {
    copy.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    copy.sort((a, b) => parseTs(b.last_verified_at) - parseTs(a.last_verified_at));
  }
  return copy;
}

function JobsTable({
  jobs,
  appliedStageByUrl,
  page,
  onPage,
}: {
  jobs: PublicJob[];
  appliedStageByUrl: Map<string, string>;
  page: number;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = jobs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-zinc-900/60">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-3 font-medium">Company</th>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Location</th>
            <th className="px-4 py-3 font-medium">Verified</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Apply</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.06]">
          {paged.map((job) => {
            const stage = appliedStageByUrl.get(normalizeUrl(job.canonical_url));
            return (
              <tr key={job.id} className="transition-colors hover:bg-white/[0.04]">
                <td className="px-4 py-3 font-medium text-zinc-100">{displayCompany(job.company_id)}</td>
                <td className="max-w-[280px] px-4 py-3 text-zinc-200" title={job.description_excerpt || undefined}>
                  {job.title}
                </td>
                <td className="max-w-[180px] truncate px-4 py-3 text-zinc-400">{displayLocation(job)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-zinc-400">{shortDate(job.last_verified_at)}</td>
                <td className="px-4 py-3">
                  {stage ? <Badge tone="green">{stage}</Badge> : <span className="text-zinc-500">—</span>}
                </td>
                <td className="px-4 py-3">
                  <a
                    href={job.canonical_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent-400 hover:text-accent-300 hover:underline"
                  >
                    Apply ↗
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
          <span className="text-xs text-zinc-500">
            Page {safePage} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={safePage <= 1} onClick={() => onPage(safePage - 1)}>
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => onPage(safePage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function JobsView() {
  const { jobs: pipelineJobs, settings } = useStore();
  const [data, setData] = useState<JobsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState('');
  const [location, setLocation] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch('/api/jobs');
        if (!r.ok) throw new Error(r.status === 503 ? 'snapshot unavailable' : `request failed (${r.status})`);
        const body = (await r.json()) as JobsResponse;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'could not load jobs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Pipeline stage by normalised apply URL — the applied merge. */
  const appliedStageByUrl = useMemo(() => {
    const stageName = new Map(settings.stages.map((s) => [s.id, s.name]));
    const byUrl = new Map<string, string>();
    for (const job of pipelineJobs) {
      const key = normalizeUrl(job.applyUrl);
      if (key && !byUrl.has(key)) byUrl.set(key, stageName.get(job.stageId) ?? job.stageId);
    }
    return byUrl;
  }, [pipelineJobs, settings.stages]);

  const jobs = data?.jobs ?? [];

  /** Dropdown options, built from the loaded jobs only. */
  const companies = useMemo(() => {
    const seen = [...new Set(jobs.map((j) => j.company_id).filter(Boolean))];
    return seen.sort((a, b) => displayCompany(a).localeCompare(displayCompany(b)));
  }, [jobs]);
  const locations = useMemo(() => {
    const seen = [...new Set(jobs.map((j) => displayLocation(j)))];
    return seen.sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const filtersActive = query.trim() !== '' || company !== '' || location !== '';

  /** Search + filters + sort, in that order. Pagination runs on this
   *  list, and any change to the search resets to page 1. */
  const visibleJobs = useMemo(
    () => sortJobs(filterJobs(jobs, { query, company, location }), sort),
    [jobs, query, company, location, sort],
  );

  useEffect(() => {
    setPage(1);
  }, [query, company, location, sort]);

  const clearSearch = () => {
    setQuery('');
    setCompany('');
    setLocation('');
  };

  if (loading) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Browse jobs</h1>
          <p className="mt-1 text-sm text-zinc-400">Loading verified jobs…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Browse jobs</h1>
        </div>
        <EmptyState
          title="Could not load verified jobs"
          description={`The jobs snapshot is unreachable right now (${error ?? 'unknown error'}). Your pipeline is unaffected — check the Pipeline tab. Try again in a moment.`}
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Browse jobs</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Verified remote US jobs as of {fullDate(data.generatedAt)} ·{' '}
            {filtersActive
              ? `${visibleJobs.length} of ${data.liveJobs} ${data.liveJobs === 1 ? 'job' : 'jobs'}`
              : `${data.liveJobs} ${data.liveJobs === 1 ? 'job' : 'jobs'} live`}
          </p>
          {data.source === 'bundled' && (
            <p className="mt-1 text-sm text-amber-400">
              Showing the copy bundled at deploy time — GitHub was unreachable, so this list may be stale.
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Refresh
        </Button>
      </div>

      {jobs.length === 0 ? (
        <EmptyState
          title="No verified jobs right now"
          description="Ingest publishes verified remote US jobs here as it finds them. Nothing has cleared verification yet — check back soon."
        />
      ) : (
        <>
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
              <Input
                type="search"
                label="Search"
                placeholder="Search title, company, or description…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select label="Company" value={company} onChange={(e) => setCompany(e.target.value)}>
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {displayCompany(c)}
                  </option>
                ))}
              </Select>
              <Select label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">All locations</option>
                {locations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
              <Select
                label="Sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="newest">Newest verified</option>
                <option value="title">Title A–Z</option>
              </Select>
              <div className="flex items-end">
                <Button variant="ghost" size="sm" onClick={clearSearch} disabled={!filtersActive}>
                  Clear
                </Button>
              </div>
            </div>
          </div>

          {visibleJobs.length === 0 ? (
            <EmptyState
              title="No verified jobs match"
              description="Nothing in the verified index matches that search. Try a different keyword or clear the filters."
              action={
                <Button variant="secondary" onClick={clearSearch}>
                  Clear search &amp; filters
                </Button>
              }
            />
          ) : (
            <JobsTable jobs={visibleJobs} appliedStageByUrl={appliedStageByUrl} page={page} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}
