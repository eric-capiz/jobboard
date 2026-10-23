import { useEffect, useMemo, useState } from 'react';
import { industryStats, type IndustryStats } from '../data/industries';
import { useStore } from '../store';
import { Button, EmptyState, Input } from './ui';

export const INDUSTRIES_PER_PAGE = 25;

function IndustryCard({ stats }: { stats: IndustryStats }) {
  return (
    <div className="flex flex-col rounded-2xl border border-white/10 bg-zinc-900/60 p-4 transition-colors hover:border-white/20">
      <h3 className="text-sm font-semibold leading-snug text-zinc-100">{stats.name}</h3>

      <div className="mt-3 flex items-baseline gap-4">
        <p className="text-2xl font-bold tracking-tight text-zinc-100">
          {stats.jobCount}
          <span className="ml-1 text-xs font-medium text-zinc-500">
            {stats.jobCount === 1 ? 'job' : 'jobs'}
          </span>
        </p>
        <p className="text-sm text-zinc-400">
          {stats.rosterCount}
          <span className="ml-1 text-xs text-zinc-500">
            {stats.rosterCount === 1 ? 'company' : 'companies'} in sweep
          </span>
        </p>
      </div>

      <p className="mt-2 text-xs text-zinc-500">
        {stats.boardCompanyCount > 0 ? (
          <>
            {stats.boardCompanyCount} on the board
            {stats.avgMatch !== null && (
              <>
                {' · '}Avg match{' '}
                <span className="font-semibold text-zinc-300">{stats.avgMatch}%</span>
              </>
            )}
            {stats.bestMatch !== null && (
              <>
                {' · '}Best <span className="font-semibold text-zinc-300">{stats.bestMatch}%</span>
              </>
            )}
          </>
        ) : (
          'No jobs on the board yet'
        )}
      </p>

      {stats.stageBreakdown.length > 0 && (
        <p className="mt-1.5 text-xs text-zinc-500">
          {stats.stageBreakdown.map((s, i) => (
            <span key={s.stageName}>
              {i > 0 && <span className="text-zinc-700"> · </span>}
              {s.stageName} <span className="text-zinc-300">{s.count}</span>
            </span>
          ))}
        </p>
      )}

      {stats.exampleCompanies.length > 0 && (
        <p className="mt-auto pt-3 text-xs leading-relaxed text-zinc-500">
          <span className="text-zinc-600">{stats.jobCount > 0 ? 'Top: ' : 'Includes: '}</span>
          {stats.exampleCompanies.join(', ')}
        </p>
      )}
    </div>
  );
}

export function IndustriesView() {
  const { jobs, settings } = useStore();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');

  const allStats = useMemo(() => industryStats(jobs, settings.stages), [jobs, settings.stages]);
  const stats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allStats;
    return allStats.filter((s) => s.name.toLowerCase().includes(q));
  }, [allStats, query]);

  const pageCount = Math.max(1, Math.ceil(stats.length / INDUSTRIES_PER_PAGE));

  useEffect(() => {
    setPage(1);
  }, [query]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  if (allStats.length === 0) {
    return (
      <EmptyState
        title="No industries yet"
        description="Industries come from the sweep's company lists. Once they load, each industry gets a card with its companies and board stats."
      />
    );
  }

  const totalCompanies = allStats.reduce((sum, s) => sum + s.rosterCount, 0);
  const start = (page - 1) * INDUSTRIES_PER_PAGE;
  const pageStats = stats.slice(start, start + INDUSTRIES_PER_PAGE);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Industries</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            {allStats.length} industries · {totalCompanies} companies in the sweep · {jobs.length}{' '}
            jobs on the board
          </p>
        </div>
        <div className="w-full sm:w-64">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search industries…"
            aria-label="Search industries"
          />
        </div>
      </div>

      {stats.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">
          No industries match “{query}”.
        </p>
      ) : (
        <>
          {pageCount > 1 && (
            <p className="text-xs text-zinc-500">
              Showing {start + 1}–{start + pageStats.length} of {stats.length}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {pageStats.map((s) => (
              <IndustryCard key={s.name} stats={s} />
            ))}
          </div>
        </>
      )}

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </Button>
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
            <Button
              key={n}
              variant={n === page ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setPage(n)}
            >
              {n}
            </Button>
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
