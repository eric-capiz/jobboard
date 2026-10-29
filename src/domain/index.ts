/* JOBBOARD domain layer — pure types & logic, no UI. Everything here is unit-testable. */

/** Canonical pipeline stages. `New` is the intake stage, `Offer` is the
 *  winning terminal stage, and `Lost` is the losing terminal stage. */
export type StageId = string;

export interface Stage {
  id: StageId;
  name: string;
  kind: 'new' | 'open' | 'won' | 'lost';
}

export const DEFAULT_STAGES: Stage[] = [
  { id: 'new', name: 'New', kind: 'new' },
  { id: 'applied', name: 'Applied', kind: 'open' },
  { id: 'interview', name: 'Interview', kind: 'open' },
  { id: 'offer', name: 'Offer', kind: 'won' },
  { id: 'lost', name: 'Lost', kind: 'lost' },
];

export type ActivityKind = 'created' | 'stage' | 'note' | 'field' | 'imported';

export interface ActivityEvent {
  id: string;
  jobId: string;
  kind: ActivityKind;
  text: string;
  at: string; // ISO timestamp
}

/** Where a job lead was found. Free-text sources collapse to 'Other'. */
export const JOB_SOURCES = ['Indeed', 'LinkedIn', 'Randstad', 'Career Page', 'Other'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export function normalizeSource(raw: string): JobSource {
  const t = (raw ?? '').trim().toLowerCase();
  for (const s of JOB_SOURCES) {
    if (s.toLowerCase() === t) return s;
  }
  if (t.includes('indeed')) return 'Indeed';
  if (t.includes('linkedin') || t.includes('linked in')) return 'LinkedIn';
  if (t.includes('randstad')) return 'Randstad';
  if (t.includes('career')) return 'Career Page';
  return 'Other';
}

export interface Job {
  id: string;
  title: string;
  company: string;
  /** Free-text location; this board tracks remote roles. */
  location: string;
  /** Salary exactly as posted, e.g. "$120k – $150k". '' when not posted. */
  salaryText: string;
  source: JobSource;
  postedDate: string; // yyyy-mm-dd or ''
  applyUrl: string;
  /** Full job description text. */
  description: string;
  /** Resume-to-job fit, 0–100. 0 means not scored yet. */
  matchScore: number;
  strengths: string[];
  gaps: string[];
  /** Label of the master resume the search that found this job used. */
  masterResumeName: string;
  /** The tailored resume for this job, as plain text. */
  tailoredResumeText: string;
  /** Download file name (without extension): Eric_<Company>_Resume. */
  tailoredFileName: string;
  stageId: StageId;
  /** Free-text notes. */
  notes: string;
  activities: ActivityEvent[];
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

/** A master resume Eric uploaded. Searches key off one chosen master, and
 *  every tailored resume is derived from the master that found the job. */
export interface MasterResume {
  id: string;
  /** User-facing name, e.g. "Frontend" or "Customer Support". */
  label: string;
  fileName: string;
  /** Extracted plain text of the resume. */
  text: string;
  uploadedAt: string; // ISO timestamp
}

export interface AppSettings {
  stages: Stage[];
  /** Master resume used by default for new searches. '' when none chosen. */
  defaultMasterResumeId: string;
}

/** A company in the Finder's database. The Finder searches these companies'
 *  careers pages for jobs. Companies arrive via Find Companies (seeded from
 *  the verified company spreadsheet; later sources append their own rows). */
export interface Company {
  id: string;
  name: string;
  website: string;
  /** Careers page URL, verified to land on real listings. '' when unknown. */
  careersUrl: string;
  category: string;
  /** Where the row came from, e.g. 'Seed'. */
  source: string;
  addedAt: string; // ISO timestamp
}

export interface PersistedState {
  version: number;
  jobs: Job[];
  masterResumes: MasterResume[];
  settings: AppSettings;
  companies: Company[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const nowIso = (): string => new Date().toISOString();

/** Today's date as local yyyy-mm-dd. */
export const todayLocal = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const formatDate = (dateStr: string): string => {
  if (!dateStr) return '—';
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

export function wordCount(text: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function clampMatchScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** Tailored resume file name (no extension): Eric_<Company>_Resume. */
export function deriveTailoredFileName(company: string): string {
  const clean = (company ?? '').trim().replace(/[\\/:*?"<>|]/g, '').trim();
  return clean ? `Eric_${clean}_Resume` : 'Eric_Resume';
}

/** Split a list field stored as text: items separated by ';' or newlines. */
export function parseListField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[;\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Dedupe                                                              */
/* ------------------------------------------------------------------ */

/** Normalize for dedupe: lowercase, trim, collapse whitespace, strip punctuation. */
export const normalizeKey = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const jobDedupeKey = (title: string, company: string): string =>
  `${normalizeKey(title)}|${normalizeKey(company)}`;

/* ------------------------------------------------------------------ */
/* Stage logic                                                         */
/* ------------------------------------------------------------------ */

/** Every transition is allowed except moving OUT of the terminal stages
 *  (Offer / Lost) back to an open stage — reopen from the job drawer. */
export function canTransition(from: Stage, to: Stage): { ok: boolean; reason?: string } {
  if (from.id === to.id) return { ok: true };
  if (from.kind === 'won' || from.kind === 'lost') {
    return {
      ok: false,
      reason: `Jobs in "${from.name}" are closed. Change the stage manually from the job drawer if you need to reopen.`,
    };
  }
  return { ok: true };
}

export function findStage(stages: Stage[], stageId: StageId): Stage {
  const found = stages.find((s) => s.id === stageId);
  if (!found) return stages[0] ?? DEFAULT_STAGES[0];
  return found;
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

export interface FunnelStep {
  stageId: string;
  stageName: string;
  count: number;
  /** % of jobs that reached the previous step which also reached this one. */
  conversionFromPrev: number | null;
  /** % of all jobs that reached this step. */
  shareOfTotal: number;
}

export function funnelMath(jobs: Job[], stages: Stage[]): FunnelStep[] {
  const openStages = stages.filter((s) => s.kind === 'new' || s.kind === 'open');
  const wonStage = stages.find((s) => s.kind === 'won');
  const ordered = wonStage ? [...openStages, wonStage] : openStages;
  const total = jobs.length;
  return ordered.map((stage, i) => {
    const count = jobs.filter((j) => j.stageId === stage.id).length;
    const prevCount =
      i === 0 ? null : ordered[i - 1] ? jobs.filter((j) => j.stageId === ordered[i - 1].id).length : 0;
    return {
      stageId: stage.id,
      stageName: stage.name,
      count,
      conversionFromPrev: prevCount === null ? null : prevCount === 0 ? 0 : (count / prevCount) * 100,
      shareOfTotal: total === 0 ? 0 : (count / total) * 100,
    };
  });
}

/** Mean match score across jobs that have been scored (score > 0). */
export function averageMatchScore(jobs: Job[]): number {
  const scored = jobs.filter((j) => j.matchScore > 0);
  if (scored.length === 0) return 0;
  return scored.reduce((sum, j) => sum + j.matchScore, 0) / scored.length;
}

export function jobsAddedThisWeek(jobs: Job[], now: Date = new Date()): number {
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return jobs.filter((j) => new Date(j.createdAt).getTime() >= weekAgo).length;
}

export function jobsBySource(jobs: Job[]): { source: string; count: number }[] {
  const map = new Map<string, number>();
  for (const j of jobs) {
    map.set(j.source, (map.get(j.source) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* Import mapping                                                      */
/* ------------------------------------------------------------------ */

export type ImportField =
  | 'title'
  | 'company'
  | 'location'
  | 'salaryText'
  | 'source'
  | 'postedDate'
  | 'applyUrl'
  | 'description'
  | 'matchScore'
  | 'strengths'
  | 'gaps'
  | 'masterResumeName'
  | 'tailoredResumeText'
  | 'tailoredFileName'
  | 'notes';

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  title: 'Title',
  company: 'Company',
  location: 'Location',
  salaryText: 'Salary',
  source: 'Source',
  postedDate: 'Posted',
  applyUrl: 'Apply Link',
  description: 'Description',
  matchScore: 'Match',
  strengths: 'Strengths',
  gaps: 'Gaps',
  masterResumeName: 'Master Resume',
  tailoredResumeText: 'Tailored Resume',
  tailoredFileName: 'Tailored File Name',
  notes: 'Notes',
};

const HEADER_ALIASES: Record<ImportField, string[]> = {
  title: ['title', 'job title', 'position', 'role', 'job'],
  company: ['company', 'company name', 'employer', 'organization', 'organisation'],
  location: ['location', 'job location', 'place'],
  salaryText: ['salary', 'salary text', 'pay', 'compensation', 'salary range'],
  source: ['source', 'board', 'site', 'found on'],
  postedDate: ['posted', 'posted date', 'date posted', 'post date', 'date'],
  applyUrl: ['apply link', 'apply url', 'application link', 'link', 'url', 'job link', 'job url'],
  description: ['description', 'job description', 'details', 'jd'],
  matchScore: ['match', 'match score', 'score', 'fit'],
  strengths: ['strengths', 'strength', 'pros', 'matches'],
  gaps: ['gaps', 'gap', 'cons', 'missing'],
  masterResumeName: ['master resume', 'master', 'resume used', 'resume'],
  tailoredResumeText: ['tailored resume', 'tailored resume text', 'tailored'],
  tailoredFileName: ['tailored file name', 'tailored filename', 'file name', 'filename'],
  notes: ['notes', 'note', 'comments', 'remarks'],
};

/** Auto-map spreadsheet headers to known fields by alias matching.
 * Two passes: exact matches win first, so "Master Resume" maps to
 * masterResumeName instead of being swallowed by a shorter alias. */
export function autoMapHeaders(headers: string[]): Record<number, ImportField | null> {
  const mapping: Record<number, ImportField | null> = {};
  const entries = Object.entries(HEADER_ALIASES) as [ImportField, string[]][];
  const normalized = headers.map((h) => normalizeKey(h));
  const matchedFields = new Set<ImportField>();

  // Pass 1: exact alias matches.
  normalized.forEach((h, idx) => {
    for (const [field, aliases] of entries) {
      if (matchedFields.has(field)) continue;
      if (aliases.some((a) => h === normalizeKey(a))) {
        mapping[idx] = field;
        matchedFields.add(field);
        break;
      }
    }
    if (!(idx in mapping)) mapping[idx] = null;
  });

  // Pass 2: substring matches for anything still unmapped.
  normalized.forEach((h, idx) => {
    if (mapping[idx] !== null) return;
    for (const [field, aliases] of entries) {
      if (matchedFields.has(field)) continue;
      if (aliases.some((a) => h.includes(normalizeKey(a)))) {
        mapping[idx] = field;
        matchedFields.add(field);
        break;
      }
    }
  });

  return mapping;
}

export interface ImportRow {
  values: Record<ImportField, string>;
  /** Optional explicit stage from a JSON import; validated downstream. */
  stageId?: string;
}

/** Split rows into new vs duplicates against existing jobs + within the batch. */
export function dedupeImportRows(
  rows: ImportRow[],
  existingJobs: Job[],
): { unique: ImportRow[]; skipped: number } {
  const seen = new Set(existingJobs.map((j) => jobDedupeKey(j.title, j.company)));
  const unique: ImportRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = jobDedupeKey(row.values.title, row.values.company);
    if (!row.values.title || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return { unique, skipped };
}

export function importRowToJob(
  row: ImportRow,
  defaults: { stageId: StageId; validStageIds: Set<string> },
): Job {
  const v = row.values;
  const ts = nowIso();
  const company = v.company.trim();
  return {
    id: uid(),
    title: v.title.trim(),
    company,
    location: v.location.trim(),
    salaryText: v.salaryText.trim(),
    source: normalizeSource(v.source),
    postedDate: v.postedDate.trim(),
    applyUrl: v.applyUrl.trim(),
    description: v.description.trim(),
    matchScore: clampMatchScore(v.matchScore),
    strengths: parseListField(v.strengths),
    gaps: parseListField(v.gaps),
    masterResumeName: v.masterResumeName.trim(),
    tailoredResumeText: v.tailoredResumeText,
    tailoredFileName: v.tailoredFileName.trim() || deriveTailoredFileName(company),
    stageId:
      row.stageId && defaults.validStageIds.has(row.stageId) ? row.stageId : defaults.stageId,
    notes: v.notes,
    activities: [
      {
        id: uid(),
        jobId: '',
        kind: 'imported',
        text: 'Job imported',
        at: ts,
      },
    ],
    createdAt: ts,
    updatedAt: ts,
  };
}

/* ------------------------------------------------------------------ */
/* Companies (Finder database)                                         */
/* ------------------------------------------------------------------ */

/** Website domain, used for company dedupe (www. stripped). */
export function companyDomain(website: string): string {
  try {
    const host = new URL(website).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return website.toLowerCase().trim();
  }
}

/** Dedupe key for companies: normalized name + website domain. */
export const companyDedupeKey = (name: string, website: string): string =>
  `${normalizeKey(name)}|${companyDomain(website)}`;

/** Split candidate company rows into new vs already-in-DB. */
export function dedupeCompanies<T extends { name: string; website: string }>(
  rows: T[],
  existing: Company[],
): { unique: T[]; skipped: number } {
  const seen = new Set(existing.map((c) => companyDedupeKey(c.name, c.website)));
  const unique: T[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = companyDedupeKey(row.name, row.website);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return { unique, skipped };
}
