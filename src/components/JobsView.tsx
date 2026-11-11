import { useMemo, useState } from 'react';
import type { Job } from '../domain';
import { useStore } from '../store';
import { Badge, Button, EmptyState } from './ui';
import { downloadTailoredResumePdf } from '../lib/resume';

/* Jobs per table page. Each table keeps its own page. */
const PAGE_SIZE = 10;

/* Jobs dashboard — one table per uploaded master resume.
 *
 * Rows are the jobs on the board, grouped by the master resume that
 * found them (Job.masterResumeName, set when Find Jobs adds a lead).
 * Jobs with no resume label — manual adds, or a label that no longer
 * matches a master resume — land in the "Manual / other" table.
 * Clicking a row opens the same JobDrawer as a Pipeline card. */

function stageName(stages: { id: string; name: string }[], stageId: string): string {
  return stages.find((s) => s.id === stageId)?.name ?? stageId;
}

function shortDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function matchTone(score: number): 'green' | 'amber' | 'default' {
  if (score >= 80) return 'green';
  if (score >= 60) return 'amber';
  return 'default';
}

function JobsTable({
  jobs,
  stages,
  onSelect,
}: {
  jobs: Job[];
  stages: { id: string; name: string }[];
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(
    () => [...jobs].sort((a, b) => b.matchScore - a.matchScore || b.createdAt.localeCompare(a.createdAt)),
    [jobs],
  );
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  // Clamp if the list shrank under the current page (jobs removed).
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-zinc-900/60">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-3 font-medium">Company</th>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Match</th>
            <th className="px-4 py-3 font-medium">Location</th>
            <th className="px-4 py-3 font-medium">Stage</th>
            <th className="px-4 py-3 font-medium">Added</th>
            <th className="px-4 py-3 font-medium">Apply</th>
            <th className="px-4 py-3 font-medium">Resume</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.06]">
          {paged.map((job) => (
            <tr
              key={job.id}
              onClick={() => onSelect(job.id)}
              className="cursor-pointer transition-colors hover:bg-white/[0.04]"
            >
              <td className="px-4 py-3 font-medium text-zinc-100">{job.company}</td>
              <td className="max-w-[280px] truncate px-4 py-3 text-zinc-200">{job.title}</td>
              <td className="px-4 py-3">
                {job.matchScore > 0 ? (
                  <Badge tone={matchTone(job.matchScore)}>{job.matchScore}%</Badge>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </td>
              <td className="max-w-[180px] truncate px-4 py-3 text-zinc-400">{job.location || '—'}</td>
              <td className="px-4 py-3">
                <Badge>{stageName(stages, job.stageId)}</Badge>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-zinc-400">{shortDate(job.createdAt)}</td>
              <td className="px-4 py-3">
                {job.applyUrl ? (
                  <a
                    href={job.applyUrl}
                    target="__blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium text-accent-400 hover:text-accent-300 hover:underline"
                  >
                    Apply ↗
                  </a>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {job.tailoredResumeText?.trim() ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadTailoredResumePdf(job);
                    }}
                  >
                    PDF
                  </Button>
                ) : (
                  <span className="text-xs text-zinc-500">Not generated</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
          <span className="text-xs text-zinc-500">
            Page {safePage} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
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
  const { jobs, masterResumes, settings, selectJob } = useStore();

  const groups = useMemo(() => {
    const labels = new Set(masterResumes.map((r) => r.label));
    const byResume = new Map<string, Job[]>();
    const other: Job[] = [];
    for (const job of jobs) {
      const label = (job.masterResumeName ?? '').trim();
      if (label && labels.has(label)) {
        const list = byResume.get(label) ?? [];
        list.push(job);
        byResume.set(label, list);
      } else {
        other.push(job);
      }
    }
    return { byResume, other };
  }, [jobs, masterResumes]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No jobs on the board yet"
        description="Run Find Jobs from the Finder — it searches your companies' careers pages with the resume you pick, and every match it adds shows up here, in that resume's table."
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">Jobs</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Every job on the board, in a table per master resume. Click a row to open it.
        </p>
      </div>

      {masterResumes.map((resume) => {
        const list = groups.byResume.get(resume.label) ?? [];
        return (
          <section key={resume.id}>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">{resume.label}</h2>
              <span className="text-xs text-zinc-500">
                {list.length} {list.length === 1 ? 'job' : 'jobs'}
              </span>
            </div>
            {list.length > 0 ? (
              <JobsTable jobs={list} stages={settings.stages} onSelect={selectJob} />
            ) : (
              <p className="rounded-2xl border border-dashed border-white/10 bg-zinc-900/40 px-4 py-6 text-sm text-zinc-500">
                No jobs from this resume yet.
              </p>
            )}
          </section>
        );
      })}

      {groups.other.length > 0 && (
        <section>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-zinc-100">Manual / other</h2>
            <span className="text-xs text-zinc-500">
              {groups.other.length} {groups.other.length === 1 ? 'job' : 'jobs'}
            </span>
          </div>
          <JobsTable jobs={groups.other} stages={settings.stages} onSelect={selectJob} />
        </section>
      )}
    </div>
  );
}
