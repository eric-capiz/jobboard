import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Job, formatDate } from '../domain';
import { downloadTailoredResumePdf } from '../lib/resume';
import { Badge } from './ui';

export function MatchChip({ score }: { score: number }) {
  if (!score || score <= 0) return null;
  const tone = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'default';
  return <Badge tone={tone}>{score}% match</Badge>;
}

export function JobCard({
  job,
  onOpen,
  dragging = false,
}: {
  job: Job;
  onOpen: () => void;
  dragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: job.id,
    data: { stageId: job.stageId, jobId: job.id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  const hasTailored = (job.tailoredResumeText ?? '').trim().length > 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className={`group cursor-grab touch-manipulation rounded-xl border border-white/10 bg-zinc-900 p-3.5 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-lg hover:shadow-black/40 active:cursor-grabbing ${
        dragging ? 'border-accent-500/60 shadow-xl shadow-accent-600/20' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">{job.title}</p>
          <p className="mt-0.5 truncate text-xs text-zinc-400">
            {job.company}
            {job.location ? ` · ${job.location}` : ''}
          </p>
        </div>
        <MatchChip score={job.matchScore} />
      </div>
      {job.salaryText && (
        <p className="mt-2 text-sm font-bold text-emerald-300">{job.salaryText}</p>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          {job.source}
        </span>
        <span className="flex items-center gap-2">
          {job.postedDate && <span className="text-[11px] text-zinc-500">Posted {formatDate(job.postedDate)}</span>}
          {hasTailored && (
            <button
              type="button"
              title={`Download ${job.tailoredFileName}.pdf`}
              aria-label={`Download tailored resume for ${job.company}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                downloadTailoredResumePdf(job);
              }}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-accent-300"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 4v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 19h16" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
