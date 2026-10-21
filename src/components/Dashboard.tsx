import { useMemo } from 'react';
import {
  averageMatchScore,
  formatDateTime,
  funnelMath,
  jobsAddedThisWeek,
  jobsBySource,
} from '../domain';
import { useStore } from '../store';
import { EmptyState } from './ui';

/* ---------- hand-rolled SVG bar chart ---------- */

function SvgBars({
  data,
  valueLabel,
  height = 180,
}: {
  data: { label: string; value: number }[];
  valueLabel: (v: number) => string;
  height?: number;
}) {
  const width = 560;
  const padL = 8;
  const padB = 44;
  const padT = 12;
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = data.length;
  const slot = (width - padL * 2) / Math.max(1, n);
  const barW = Math.min(56, slot * 0.55);
  const chartH = height - padB - padT;

  if (data.length === 0) return <p className="py-8 text-center text-sm text-zinc-500">No data yet.</p>;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Bar chart">
      {[0.25, 0.5, 0.75, 1].map((t) => {
        const y = padT + chartH * (1 - t);
        return (
          <g key={t}>
            <line x1={padL} x2={width - padL} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 4" />
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = Math.max(3, (d.value / max) * chartH);
        const x = padL + slot * i + (slot - barW) / 2;
        const y = padT + chartH - h;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} rx={5} fill="url(#jobboardBar)" />
            <text x={x + barW / 2} y={y - 6} textAnchor="middle" fill="#e4e4e7" fontSize="11" fontWeight="600">
              {valueLabel(d.value)}
            </text>
            <text x={x + barW / 2} y={height - 26} textAnchor="middle" fill="#71717a" fontSize="10.5">
              {d.label.length > 14 ? d.label.slice(0, 13) + '…' : d.label}
            </text>
          </g>
        );
      })}
      <defs>
        <linearGradient id="jobboardBar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ---------- funnel (SVG) ---------- */

function Funnel({ steps }: { steps: { stageName: string; count: number; conversionFromPrev: number | null }[] }) {
  const width = 560;
  const rowH = 52;
  const height = steps.length * rowH + 8;
  const max = Math.max(1, ...steps.map((s) => s.count));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Conversion funnel">
      <defs>
        <linearGradient id="jobboardFunnel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      {steps.map((s, i) => {
        const w = Math.max(4, (s.count / max) * (width - 220));
        const y = i * rowH + 6;
        return (
          <g key={s.stageName}>
            <text x={0} y={y + 14} fill="#e4e4e7" fontSize="12" fontWeight="600">
              {s.stageName}
            </text>
            <text x={0} y={y + 30} fill="#71717a" fontSize="11">
              {s.conversionFromPrev === null ? `${s.count} jobs` : `${s.conversionFromPrev.toFixed(1)}% of prev`}
            </text>
            <rect x={200} y={y} width={w} height={26} rx={6} fill="url(#jobboardFunnel)" opacity={0.9 - i * 0.06} />
            <text x={200 + w + 8} y={y + 17} fill="#a1a1aa" fontSize="12" fontWeight="600">
              {s.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- dashboard ---------- */

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 transition-colors hover:border-white/20">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-zinc-100">{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

export function Dashboard() {
  const { jobs, masterResumes, settings, selectJob } = useStore();

  const funnel = useMemo(() => funnelMath(jobs, settings.stages), [jobs, settings.stages]);
  const bySource = useMemo(() => jobsBySource(jobs), [jobs]);
  const stageCounts = useMemo(
    () =>
      settings.stages.map((s) => ({
        label: s.name,
        value: jobs.filter((j) => j.stageId === s.id).length,
      })),
    [jobs, settings.stages],
  );
  const activity = useMemo(
    () =>
      jobs
        .flatMap((j) => j.activities.map((a) => ({ ...a, jobLabel: `${j.title} · ${j.company}` })))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 8),
    [jobs],
  );

  const avgMatch = averageMatchScore(jobs);
  const addedThisWeek = jobsAddedThisWeek(jobs);
  const openCount = jobs.filter(
    (j) => settings.stages.find((s) => s.id === j.stageId)?.kind !== 'won' && settings.stages.find((s) => s.id === j.stageId)?.kind !== 'lost',
  ).length;

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No data to show yet"
        description="Add a master resume to get started — searches key off the resume you pick. Once jobs land on the board, counts, match averages, and your funnel show up here automatically."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Total jobs" value={String(jobs.length)} sub={`${openCount} still in play`} />
        <StatCard
          label="Average match"
          value={avgMatch > 0 ? `${avgMatch.toFixed(0)}%` : '—'}
          sub="Across scored jobs"
        />
        <StatCard label="Added this week" value={String(addedThisWeek)} sub="Last 7 days" />
        <StatCard
          label="Master resumes"
          value={String(masterResumes.length)}
          sub={masterResumes.length === 1 ? 'Searches key off it' : 'Pick one per search'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-100">Pipeline funnel</h2>
          <Funnel steps={funnel} />
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-100">Jobs by stage</h2>
          <SvgBars data={stageCounts} valueLabel={(v) => String(v)} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-100">Jobs by source</h2>
          <SvgBars data={bySource.map((s) => ({ label: s.source, value: s.count }))} valueLabel={(v) => String(v)} />
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-100">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">No activity yet.</p>
          ) : (
            <ul className="space-y-1">
              {activity.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => selectJob(a.jobId)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">
                        <span className="font-medium text-zinc-100">{a.jobLabel}</span>
                        <span className="text-zinc-500"> — </span>
                        {a.text}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-zinc-500">{formatDateTime(a.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
