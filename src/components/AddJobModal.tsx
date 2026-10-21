import { useState } from 'react';
import { JOB_SOURCES, JobSource, StageId, clampMatchScore, deriveTailoredFileName, parseListField } from '../domain';
import { useStore } from '../store';
import { Button, FieldRow, Input, Modal, Select, Textarea } from './ui';

export function AddJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { addJob, settings, masterResumes } = useStore();
  const [form, setForm] = useState({
    title: '',
    company: '',
    location: 'Remote',
    salaryText: '',
    source: 'Indeed' as string,
    postedDate: '',
    applyUrl: '',
    matchScore: '',
    masterResumeName: '',
    strengths: '',
    gaps: '',
    description: '',
    tailoredResumeText: '',
    tailoredFileName: '',
    notes: '',
    stageId: settings.stages[0]?.id ?? 'new',
  });

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function reset() {
    setForm({
      title: '',
      company: '',
      location: 'Remote',
      salaryText: '',
      source: 'Indeed',
      postedDate: '',
      applyUrl: '',
      matchScore: '',
      masterResumeName: '',
      strengths: '',
      gaps: '',
      description: '',
      tailoredResumeText: '',
      tailoredFileName: '',
      notes: '',
      stageId: settings.stages[0]?.id ?? 'new',
    });
  }

  function save() {
    if (!form.title.trim() || !form.company.trim()) return;
    const company = form.company.trim();
    addJob({
      title: form.title.trim(),
      company,
      location: form.location.trim(),
      salaryText: form.salaryText.trim(),
      source: (JOB_SOURCES as readonly string[]).includes(form.source)
        ? (form.source as JobSource)
        : 'Other',
      postedDate: form.postedDate,
      applyUrl: form.applyUrl.trim(),
      description: form.description,
      matchScore: clampMatchScore(form.matchScore),
      strengths: parseListField(form.strengths),
      gaps: parseListField(form.gaps),
      masterResumeName: form.masterResumeName.trim(),
      tailoredResumeText: form.tailoredResumeText,
      tailoredFileName: form.tailoredFileName.trim() || deriveTailoredFileName(company),
      stageId: form.stageId as StageId,
      notes: form.notes,
    });
    reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Add job" wide>
      <div className="space-y-4">
        <FieldRow>
          <Input label="Job title *" value={form.title} onChange={set('title')} placeholder="e.g. Frontend Engineer" autoFocus />
          <Input label="Company *" value={form.company} onChange={set('company')} placeholder="e.g. Rocket Money" />
        </FieldRow>
        <FieldRow>
          <Input label="Location" value={form.location} onChange={set('location')} placeholder="Remote" />
          <Input label="Salary" value={form.salaryText} onChange={set('salaryText')} placeholder="$120k – $150k" />
        </FieldRow>
        <FieldRow>
          <Select label="Source" value={form.source} onChange={set('source')}>
            {JOB_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input label="Posted date" type="date" value={form.postedDate} onChange={set('postedDate')} />
        </FieldRow>
        <FieldRow>
          <Input label="Apply link" value={form.applyUrl} onChange={set('applyUrl')} placeholder="https://…" />
          <Input label="Match score (0–100)" type="number" min={0} max={100} value={form.matchScore} onChange={set('matchScore')} />
        </FieldRow>
        <FieldRow>
          <Input
            label="Master resume"
            value={form.masterResumeName}
            onChange={set('masterResumeName')}
            placeholder={masterResumes[0]?.label ?? 'e.g. Frontend'}
          />
          <Select label="Stage" value={form.stageId} onChange={set('stageId')}>
            {settings.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow>
          <Textarea label="Strengths (one per line)" value={form.strengths} onChange={set('strengths')} rows={3} />
          <Textarea label="Gaps (one per line)" value={form.gaps} onChange={set('gaps')} rows={3} />
        </FieldRow>
        <Textarea label="Job description" value={form.description} onChange={set('description')} rows={5} placeholder="Paste the full posting…" />
        <Textarea label="Tailored resume text" value={form.tailoredResumeText} onChange={set('tailoredResumeText')} rows={5} placeholder="The tailored version of the master resume for this job…" />
        <FieldRow>
          <Input
            label="Tailored file name"
            value={form.tailoredFileName}
            onChange={set('tailoredFileName')}
            placeholder={form.company ? deriveTailoredFileName(form.company) : 'Eric_<Company>_Resume'}
          />
          <Input label="Notes" value={form.notes} onChange={set('notes')} placeholder="Anything worth remembering" />
        </FieldRow>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!form.title.trim() || !form.company.trim()}>
            Add job
          </Button>
        </div>
      </div>
    </Modal>
  );
}
