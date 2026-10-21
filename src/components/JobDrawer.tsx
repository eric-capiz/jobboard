import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ActivityEvent,
  JOB_SOURCES,
  Job,
  JobSource,
  canTransition,
  clampMatchScore,
  deriveTailoredFileName,
  findStage,
  formatDate,
  formatDateTime,
  parseListField,
} from '../domain';
import { useStore } from '../store';
import { downloadTailoredResumePdf } from '../lib/resume';
import { MatchChip } from './JobCard';
import { Badge, Button, Input, Select, Textarea } from './ui';

function DetailRow({ label, value, href }: { label: string; value: string; href?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium text-accent-300 hover:text-accent-200 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="truncate text-sm text-zinc-200">{value}</span>
      )}
    </div>
  );
}

const ACTIVITY_LABELS: Record<ActivityEvent['kind'], string> = {
  created: 'Created',
  stage: 'Stage',
  note: 'Note',
  field: 'Update',
  imported: 'Import',
};

function StringList({ items, emptyText }: { items: string[]; emptyText: string }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">{emptyText}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-zinc-200">
          <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function EditJobForm({ job, onDone }: { job: Job; onDone: () => void }) {
  const { updateJob, masterResumes } = useStore();
  const [form, setForm] = useState({
    title: job.title,
    company: job.company,
    location: job.location,
    salaryText: job.salaryText,
    source: job.source as string,
    postedDate: job.postedDate,
    applyUrl: job.applyUrl,
    masterResumeName: job.masterResumeName,
    matchScore: String(job.matchScore),
    strengths: job.strengths.join('\n'),
    gaps: job.gaps.join('\n'),
    description: job.description,
  });
  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function save() {
    if (!form.title.trim() || !form.company.trim()) return;
    updateJob(
      job.id,
      {
        title: form.title.trim(),
        company: form.company.trim(),
        location: form.location.trim(),
        salaryText: form.salaryText.trim(),
        source: (JOB_SOURCES as readonly string[]).includes(form.source)
          ? (form.source as JobSource)
          : 'Other',
        postedDate: form.postedDate,
        applyUrl: form.applyUrl.trim(),
        masterResumeName: form.masterResumeName.trim(),
        matchScore: clampMatchScore(form.matchScore),
        strengths: parseListField(form.strengths),
        gaps: parseListField(form.gaps),
        description: form.description,
      },
      'Updated job details',
      'field',
    );
    onDone();
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Job title" value={form.title} onChange={set('title')} />
        <Input label="Company" value={form.company} onChange={set('company')} />
        <Input label="Location" value={form.location} onChange={set('location')} placeholder="Remote" />
        <Input label="Salary" value={form.salaryText} onChange={set('salaryText')} placeholder="$120k – $150k" />
        <Select label="Source" value={form.source} onChange={set('source')}>
          {JOB_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input label="Posted date" type="date" value={form.postedDate} onChange={set('postedDate')} />
        <Input label="Match score (0–100)" type="number" min={0} max={100} value={form.matchScore} onChange={set('matchScore')} />
        <Input
          label="Master resume"
          value={form.masterResumeName}
          onChange={set('masterResumeName')}
          placeholder={masterResumes[0]?.label ?? 'e.g. Frontend'}
        />
      </div>
      <Input label="Apply link" value={form.applyUrl} onChange={set('applyUrl')} placeholder="https://…" />
      <Textarea label="Strengths (one per line)" value={form.strengths} onChange={set('strengths')} rows={3} />
      <Textarea label="Gaps (one per line)" value={form.gaps} onChange={set('gaps')} rows={3} />
      <Textarea label="Description" value={form.description} onChange={set('description')} rows={6} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

function TailoredResumeSection({ job }: { job: Job }) {
  const { updateJob } = useStore();
  const [showText, setShowText] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fileName, setFileName] = useState(job.tailoredFileName);
  const [text, setText] = useState(job.tailoredResumeText);

  useEffect(() => {
    setShowText(false);
    setEditing(false);
    setFileName(job.tailoredFileName);
    setText(job.tailoredResumeText);
  }, [job.id, job.tailoredFileName, job.tailoredResumeText]);

  const hasText = (job.tailoredResumeText ?? '').trim().length > 0;
  const displayName = job.tailoredFileName?.trim() || deriveTailoredFileName(job.company);

  function save() {
    updateJob(
      job.id,
      {
        tailoredFileName: fileName.trim() || deriveTailoredFileName(job.company),
        tailoredResumeText: text,
      },
      'Updated tailored resume',
      'field',
    );
    setEditing(false);
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tailored resume</h3>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-accent-300 hover:text-accent-200"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-3">
          <Input label="File name" value={fileName} onChange={(e) => setFileName(e.target.value)} hint="Downloads save as <file name>.pdf" />
          <Textarea label="Resume text" value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder="The tailored resume for this job, as plain text…" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={save}>
              Save resume
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-3.5">
          <p className="truncate text-sm font-medium text-zinc-200" title={`${displayName}.pdf`}>
            {displayName}.pdf
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Tailored from {job.masterResumeName ? `the “${job.masterResumeName}” master` : 'a master resume'}
          </p>
          {hasText ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={() => downloadTailoredResumePdf(job)}>
                  Download PDF
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setShowText((s) => !s)}>
                  {showText ? 'Hide resume' : 'View resume'}
                </Button>
              </div>
              {showText && (
                <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/[0.07] bg-zinc-950/60 p-3 font-sans text-xs leading-relaxed text-zinc-300">
                  {job.tailoredResumeText}
                </pre>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              No tailored resume yet — hit Edit to paste one in.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function JobDrawer() {
  const { selectedJob, selectJob, updateJob, moveJob, addActivityNote, deleteJob, settings } = useStore();
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [activityText, setActivityText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset local UI state when switching jobs.
  useEffect(() => {
    setEditing(false);
    setNoteText(selectedJob?.notes ?? '');
    setActivityText('');
    setConfirmDelete(false);
  }, [selectedJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selectedJob) return null;
  const job = selectedJob;
  const stage = findStage(settings.stages, job.stageId);

  function handleStageChange(toStageId: string) {
    const to = findStage(settings.stages, toStageId);
    const check = canTransition(stage, to);
    if (!check.ok) {
      // Terminal stages reopen from the drawer deliberately.
      updateJob(job.id, { stageId: toStageId }, `Moved from ${stage.name} to ${to.name}`, 'stage');
      return;
    }
    moveJob(job.id, toStageId);
  }

  function saveNotes() {
    if (noteText !== job.notes) {
      updateJob(job.id, { notes: noteText });
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => selectJob(null)}
      />
      <motion.aside
        key="drawer"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-white/10 bg-zinc-950 shadow-2xl shadow-black/60 sm:max-w-lg"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        role="dialog"
        aria-label={`Job details for ${job.title} at ${job.company}`}
      >
        {/* Header */}
        <div className="border-b border-white/10 px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold text-zinc-100">{job.title}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                {job.company}
                {job.location ? ` · ${job.location}` : ''}
              </p>
            </div>
            <button
              onClick={() => selectJob(null)}
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
              aria-label="Close job details"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Select
              value={job.stageId}
              onChange={(e) => handleStageChange(e.target.value)}
              className="!w-auto !py-1.5 text-sm font-semibold"
              aria-label="Pipeline stage"
            >
              {settings.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <MatchChip score={job.matchScore} />
            <Badge tone="default">{job.source}</Badge>
            {job.applyUrl && (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg shadow-accent-600/25 transition-colors hover:bg-accent-500"
              >
                Apply
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M7 17L17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          {/* Details */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Details</h3>
              {!editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs font-medium text-accent-300 hover:text-accent-200"
                >
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <EditJobForm job={job} onDone={() => setEditing(false)} />
            ) : (
              <div className="divide-y divide-white/5 rounded-xl border border-white/10 bg-zinc-900/60 px-4">
                <DetailRow label="Company" value={job.company} />
                <DetailRow label="Location" value={job.location} />
                <DetailRow label="Salary" value={job.salaryText} />
                <DetailRow label="Source" value={job.source} />
                <DetailRow label="Posted" value={job.postedDate ? formatDate(job.postedDate) : ''} />
                <DetailRow label="Match" value={job.matchScore > 0 ? `${job.matchScore}%` : ''} />
                <DetailRow label="Master resume" value={job.masterResumeName} />
                <DetailRow label="Apply link" value={job.applyUrl ? 'Open posting →' : ''} href={job.applyUrl || undefined} />
                {!job.location && !job.salaryText && !job.applyUrl && (
                  <p className="py-3 text-sm text-zinc-500">No details yet — hit Edit to add them.</p>
                )}
              </div>
            )}
          </section>

          {/* Strengths & gaps */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Why this fits</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3.5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">Strengths</p>
                <StringList items={job.strengths} emptyText="No strengths recorded." />
              </div>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3.5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">Gaps</p>
                <StringList items={job.gaps} emptyText="No gaps recorded." />
              </div>
            </div>
          </section>

          {/* Description */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Job description</h3>
            {job.description ? (
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-zinc-900/60 p-4 text-sm leading-relaxed text-zinc-300">
                {job.description}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">No description saved yet — hit Edit above to paste it in.</p>
            )}
          </section>

          {/* Tailored resume */}
          <TailoredResumeSection job={job} />

          {/* Notes */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Notes</h3>
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onBlur={saveNotes}
              placeholder="Free-form notes — recruiter names, deadlines, follow-ups…"
              rows={3}
            />
            {noteText !== job.notes && (
              <div className="mt-2 flex justify-end">
                <Button variant="secondary" size="sm" onClick={saveNotes}>
                  Save notes
                </Button>
              </div>
            )}
          </section>

          {/* Activity */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Activity</h3>
            <div className="flex gap-2">
              <Input
                value={activityText}
                onChange={(e) => setActivityText(e.target.value)}
                placeholder="Log an update…"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && activityText.trim()) {
                    addActivityNote(job.id, activityText.trim());
                    setActivityText('');
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                className="self-end"
                disabled={!activityText.trim()}
                onClick={() => {
                  addActivityNote(job.id, activityText.trim());
                  setActivityText('');
                }}
              >
                Add
              </Button>
            </div>
            <ol className="relative mt-4 space-y-3 border-l border-white/10 pl-4">
              {job.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 bg-zinc-600" />
                  <p className="text-sm text-zinc-300">{a.text}</p>
                  <p className="text-[11px] text-zinc-500">
                    {ACTIVITY_LABELS[a.kind]} · {formatDateTime(a.at)}
                  </p>
                </li>
              ))}
              {job.activities.length === 0 && <li className="text-sm text-zinc-500">No activity yet.</li>}
            </ol>
          </section>

          {/* Danger */}
          <section className="pb-4">
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs font-medium text-zinc-500 hover:text-red-400"
              >
                Delete this job
              </button>
            ) : (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3.5">
                <p className="text-sm text-zinc-200">
                  Delete <span className="font-semibold">{job.title}</span> at{' '}
                  <span className="font-semibold">{job.company}</span>? This can't be undone.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      deleteJob(job.id);
                      selectJob(null);
                    }}
                  >
                    Delete permanently
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}
