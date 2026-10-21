import { useMemo, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { motion, AnimatePresence } from 'framer-motion';
import { JOB_SOURCES, Job, Stage, StageId } from '../domain';
import { JobFilters, SortKey, filterJobs } from '../domain/filters';
import { useStore } from '../store';
import { JobCard } from './JobCard';
import { Button, EmptyState, Select } from './ui';

const MATCH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Any score' },
  { value: 50, label: '50%+' },
  { value: 70, label: '70%+' },
  { value: 85, label: '85%+' },
];

const STAGE_DOTS = ['bg-sky-500', 'bg-amber-500', 'bg-violet-500', 'bg-teal-500', 'bg-rose-500'];

function Column({
  stage,
  jobs,
  onOpenJob,
  index,
}: {
  stage: Stage;
  jobs: Job[];
  onOpenJob: (id: string) => void;
  index: number;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${stage.id}`,
    data: { stageId: stage.id, isColumn: true },
  });
  const accent = stage.kind === 'won' ? 'emerald' : stage.kind === 'lost' ? 'zinc' : 'accent';

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[290px] shrink-0 flex-col rounded-2xl border bg-zinc-900/50 transition-colors sm:w-[300px] ${
        isOver ? 'border-accent-500/60 bg-zinc-900/80' : 'border-white/[0.07]'
      }`}
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              accent === 'emerald' ? 'bg-emerald-500' : accent === 'zinc' ? 'bg-zinc-400' : STAGE_DOTS[index % STAGE_DOTS.length]
            }`}
          />
          <h3 className="text-sm font-semibold text-zinc-100">{stage.name}</h3>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs font-medium text-zinc-400">
            {jobs.length}
          </span>
        </div>
      </div>
      <div className="flex max-h-[calc(100vh-340px)] min-h-[120px] flex-col gap-2.5 overflow-y-auto px-3 pb-4 lg:max-h-[calc(100vh-300px)]">
        <SortableContext items={jobs.map((j) => j.id)} strategy={verticalListSortingStrategy}>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onOpen={() => onOpenJob(job.id)} />
          ))}
        </SortableContext>
        {jobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-500">
            Drop jobs here
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ onAddJob }: { onAddJob: () => void }) {
  const { jobs, settings, moveJob, selectJob } = useStore();
  const [filters, setFilters] = useState<JobFilters>({
    query: '',
    sources: [],
    stages: [],
    minMatch: 0,
    sort: 'recent',
  });
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const stages = settings.stages;
  const filtered = useMemo(() => filterJobs(jobs, filters, stages), [jobs, filters, stages]);
  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const set = <K extends keyof JobFilters>(key: K, value: JobFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const toggleSource = (src: string) =>
    setFilters((f) => ({
      ...f,
      sources: f.sources.includes(src) ? f.sources.filter((s) => s !== src) : [...f.sources, src],
    }));

  const toggleStage = (id: string) =>
    setFilters((f) => ({
      ...f,
      stages: f.stages.includes(id) ? f.stages.filter((s) => s !== id) : [...f.stages, id],
    }));

  const activeFilterCount =
    filters.sources.length + filters.stages.length + (filters.minMatch > 0 ? 1 : 0);

  function handleDragStart(e: DragStartEvent) {
    setActiveJobId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    const jobId = String(e.active.id);
    setActiveJobId(null);
    const over = e.over;
    if (!over) return;
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;

    // Resolve the target stage: either a column, or a card inside a column.
    const overData = over.data.current as { stageId?: StageId; jobId?: string; isColumn?: boolean } | undefined;
    let targetStageId: StageId | undefined = overData?.stageId;
    if (!overData?.isColumn && overData?.jobId) {
      const overJob = jobs.find((j) => j.id === overData.jobId);
      targetStageId = overJob?.stageId;
    }
    if (!targetStageId || targetStageId === job.stageId) return;

    const target = stages.find((s) => s.id === targetStageId);
    if (!target) return;
    moveJob(jobId, targetStageId);
  }

  const hasAnyJobs = jobs.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            value={filters.query}
            onChange={(e) => set('query', e.target.value)}
            placeholder="Search title, company…"
            className="w-full rounded-lg border border-white/10 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </div>
        <Button variant={showFilters || activeFilterCount > 0 ? 'primary' : 'secondary'} size="sm" onClick={() => setShowFilters((s) => !s)}>
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-white/20 px-1.5 text-[11px] font-bold">{activeFilterCount}</span>
          )}
        </Button>
        <Select
          value={filters.sort}
          onChange={(e) => set('sort', e.target.value as SortKey)}
          className="!w-auto"
          aria-label="Sort jobs"
        >
          <option value="recent">Recently active</option>
          <option value="match">Match score</option>
          <option value="posted">Posted date</option>
          <option value="title">Title A–Z</option>
        </Select>
        <div className="ml-auto">
          <Button variant="primary" size="sm" onClick={onAddJob}>
            + Add job
          </Button>
        </div>
      </div>

      {/* Filter panel */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mb-4 rounded-xl border border-white/10 bg-zinc-900/60 p-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Source</p>
                  <div className="flex flex-wrap gap-1.5">
                    {JOB_SOURCES.map((s) => (
                      <button
                        key={s}
                        onClick={() => toggleSource(s)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          filters.sources.includes(s)
                            ? 'border-accent-500/50 bg-accent-500/15 text-accent-200'
                            : 'border-white/10 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Stage</p>
                  <div className="flex flex-wrap gap-1.5">
                    {stages.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => toggleStage(s.id)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          filters.stages.includes(s.id)
                            ? 'border-accent-500/50 bg-accent-500/15 text-accent-200'
                            : 'border-white/10 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Minimum match</p>
                  <div className="flex flex-wrap gap-1.5">
                    {MATCH_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        onClick={() => set('minMatch', o.value)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          filters.minMatch === o.value
                            ? 'border-accent-500/50 bg-accent-500/15 text-accent-200'
                            : 'border-white/10 bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {activeFilterCount > 0 && (
                <button
                  onClick={() => setFilters((f) => ({ ...f, sources: [], stages: [], minMatch: 0 }))}
                  className="mt-3 text-xs font-medium text-accent-300 hover:text-accent-200"
                >
                  Clear all filters
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Board */}
      {!hasAnyJobs ? (
        <EmptyState
          title="No jobs yet"
          description="Add a master resume to get started — searches key off the resume you pick. Then add jobs manually, or import a spreadsheet of postings."
          action={
            <Button variant="primary" onClick={onAddJob}>
              + Add job
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No jobs match these filters"
          description="Try widening your search or clearing a filter chip above."
          action={
            <Button
              variant="secondary"
              onClick={() => setFilters((f) => ({ ...f, query: '', sources: [], stages: [], minMatch: 0 }))}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="kanban-scroll -mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 lg:mx-0 lg:px-0">
            {stages.map((stage) => {
              const inStage = filtered.filter((j) => j.stageId === stage.id);
              return <Column key={stage.id} stage={stage} jobs={inStage} onOpenJob={selectJob} index={stages.indexOf(stage)} />;
            })}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
            {activeJob ? (
              <div className="w-[290px] rotate-2">
                <JobCard job={activeJob} onOpen={() => undefined} dragging />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
