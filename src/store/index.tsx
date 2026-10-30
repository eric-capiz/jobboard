import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityEvent,
  ActivityKind,
  AppSettings,
  Company,
  DEFAULT_STAGES,
  ImportRow,
  Job,
  MasterResume,
  PersistedState,
  Stage,
  StageId,
  canTransition,
  clampMatchScore,
  dedupeImportRows,
  deriveTailoredFileName,
  findStage,
  importRowToJob,
  normalizeSource,
  nowIso,
  parseListField,
  todayLocal,
  uid,
} from '../domain';
import { fetchCloudState, getSyncKey, pushCloudStateDebounced } from '../sync';

export const STORAGE_KEY = 'jobboard-state-v1';
export const CURRENT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* State + actions                                                     */
/* ------------------------------------------------------------------ */

export interface StoreState {
  jobs: Job[];
  masterResumes: MasterResume[];
  settings: AppSettings;
  selectedJobId: string | null;
  initialized: boolean;
}

export type Action =
  | { type: 'ADD_JOB'; job: Job }
  | { type: 'IMPORT_JOBS'; rows: ImportRow[] }
  | { type: 'UPDATE_JOB'; id: string; patch: Partial<Job>; activityText?: string; activityKind?: ActivityKind }
  | { type: 'MOVE_JOB'; id: string; toStageId: StageId }
  | { type: 'DELETE_JOB'; id: string }
  | { type: 'ADD_ACTIVITY_NOTE'; jobId: string; text: string }
  | { type: 'SELECT_JOB'; id: string | null }
  | { type: 'ADD_MASTER_RESUME'; resume: MasterResume }
  | { type: 'DELETE_MASTER_RESUME'; id: string }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<AppSettings> }
  | { type: 'SET_STAGES'; stages: Stage[] }
  | { type: 'RESET_ALL' }
  | { type: 'REPLACE_ALL'; state: PersistedState }
  | { type: 'INIT_DONE' };

function logActivity(job: Job, kind: ActivityKind, text: string): ActivityEvent {
  return { id: uid(), jobId: job.id, kind, text, at: nowIso() };
}

function touch(job: Job, activity?: ActivityEvent): Job {
  const activities = activity ? [activity, ...job.activities] : job.activities;
  return { ...job, updatedAt: nowIso(), activities };
}

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case 'ADD_JOB': {
      const job = action.job;
      const activity = logActivity(job, 'created', 'Job added');
      return { ...state, jobs: [touch({ ...job, activities: [] }, activity), ...state.jobs] };
    }
    case 'IMPORT_JOBS': {
      const { unique } = dedupeImportRows(action.rows, state.jobs);
      const validStageIds = new Set(state.settings.stages.map((s) => s.id));
      const imported = unique.map((row) =>
        importRowToJob(row, {
          stageId: state.settings.stages[0]?.id ?? 'new',
          validStageIds,
        }),
      );
      const withActivity = imported.map((job) => {
        const activity = logActivity(job, 'imported', 'Job imported');
        return touch({ ...job, activities: [] }, { ...activity, jobId: job.id });
      });
      return { ...state, jobs: [...withActivity, ...state.jobs] };
    }
    case 'UPDATE_JOB': {
      return {
        ...state,
        jobs: state.jobs.map((j) => {
          if (j.id !== action.id) return j;
          return touch(
            { ...j, ...action.patch },
            action.activityText
              ? logActivity(j, action.activityKind ?? 'field', action.activityText)
              : undefined,
          );
        }),
      };
    }
    case 'MOVE_JOB': {
      const job = state.jobs.find((j) => j.id === action.id);
      if (!job) return state;
      const from = findStage(state.settings.stages, job.stageId);
      const to = findStage(state.settings.stages, action.toStageId);
      const check = canTransition(from, to);
      if (!check.ok) return state; // UI surfaces its own warning; keep store safe.
      const text = `Moved from ${from.name} to ${to.name}`;
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.id === action.id
            ? touch({ ...j, stageId: action.toStageId }, logActivity(j, 'stage', text))
            : j,
        ),
      };
    }
    case 'DELETE_JOB':
      return {
        ...state,
        jobs: state.jobs.filter((j) => j.id !== action.id),
        selectedJobId: state.selectedJobId === action.id ? null : state.selectedJobId,
      };
    case 'ADD_ACTIVITY_NOTE': {
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.id === action.jobId ? touch(j, logActivity(j, 'note', action.text)) : j,
        ),
      };
    }
    case 'SELECT_JOB':
      return { ...state, selectedJobId: action.id };
    case 'ADD_MASTER_RESUME':
      return { ...state, masterResumes: [action.resume, ...state.masterResumes] };
    case 'DELETE_MASTER_RESUME': {
      const masterResumes = state.masterResumes.filter((r) => r.id !== action.id);
      return {
        ...state,
        masterResumes,
        settings:
          state.settings.defaultMasterResumeId === action.id
            ? { ...state.settings, defaultMasterResumeId: '' }
            : state.settings,
      };
    }
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'SET_STAGES': {
      const stages = action.stages;
      // Reassign jobs whose stage vanished to the first stage.
      const validIds = new Set(stages.map((s) => s.id));
      const fallback = stages.find((s) => s.kind === 'new')?.id ?? stages[0]?.id ?? 'new';
      return {
        ...state,
        settings: { ...state.settings, stages },
        jobs: state.jobs.map((j) => (validIds.has(j.stageId) ? j : touch({ ...j, stageId: fallback }))),
      };
    }
    case 'RESET_ALL':
      return { ...initialState(), initialized: true };
    case 'REPLACE_ALL':
      // Companies are NOT part of client state anymore: they live in the
      // server-side companies collection. Any companies field on the
      // incoming payload is deliberately ignored here.
      return {
        jobs: action.state.jobs,
        masterResumes: action.state.masterResumes,
        settings: action.state.settings,
        selectedJobId: null,
        initialized: true,
      };
    case 'INIT_DONE':
      return { ...state, initialized: true };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Persistence + migration                                             */
/* ------------------------------------------------------------------ */

export function defaultSettings(): AppSettings {
  return {
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
    defaultMasterResumeId: '',
  };
}

function initialState(): StoreState {
  return {
    jobs: [],
    masterResumes: [],
    settings: defaultSettings(),
    selectedJobId: null,
    initialized: false,
  };
}

function normalizeJob(raw: unknown): Job {
  const j = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Job>;
  const ts = nowIso();
  const company = String(j.company ?? '');
  return {
    id: typeof j.id === 'string' ? j.id : uid(),
    title: String(j.title ?? ''),
    company,
    location: String(j.location ?? ''),
    salaryText: String(j.salaryText ?? ''),
    source: normalizeSource(String(j.source ?? '')),
    postedDate: String(j.postedDate ?? ''),
    applyUrl: String(j.applyUrl ?? ''),
    description: String(j.description ?? ''),
    matchScore: clampMatchScore(j.matchScore),
    strengths: parseListField(j.strengths),
    gaps: parseListField(j.gaps),
    masterResumeName: String(j.masterResumeName ?? ''),
    tailoredResumeText: String(j.tailoredResumeText ?? ''),
    tailoredFileName:
      typeof j.tailoredFileName === 'string' && j.tailoredFileName.trim()
        ? j.tailoredFileName
        : deriveTailoredFileName(company),
    stageId: String(j.stageId ?? 'new'),
    notes: String(j.notes ?? ''),
    activities: Array.isArray(j.activities) ? j.activities : [],
    createdAt: String(j.createdAt ?? ts),
    updatedAt: String(j.updatedAt ?? ts),
  };
}

function normalizeMasterResume(raw: unknown): MasterResume {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MasterResume>;
  return {
    id: typeof r.id === 'string' ? r.id : uid(),
    label: String(r.label ?? 'Resume'),
    fileName: String(r.fileName ?? ''),
    text: String(r.text ?? ''),
    uploadedAt: String(r.uploadedAt ?? nowIso()),
  };
}

function normalizeSettings(raw: unknown): AppSettings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<AppSettings>;
  return {
    stages:
      Array.isArray(s.stages) && s.stages.length > 0
        ? s.stages.map((st) => ({
            id: String(st?.id ?? uid()),
            name: String(st?.name ?? 'Stage'),
            kind: (st?.kind ?? 'open') as Stage['kind'],
          }))
        : defaultSettings().stages,
    defaultMasterResumeId: String(s.defaultMasterResumeId ?? ''),
  };
}

/** Migrate any stored payload up to CURRENT_VERSION. Pure & testable.
 *  A legacy payload's companies field is deliberately IGNORED here — it is
 *  never put in the store. Legacy companies reach the server-side collection
 *  via runCompanyMigrationOnce (local payload) and POST /api/companies/migrate
 *  (cloud state doc), which run before any reconciliation dispatch. The
 *  companies: [] below only satisfies the PersistedState backup shape; the
 *  store itself carries no companies. */
export function migrate(raw: unknown): PersistedState {
  const base: PersistedState = {
    version: CURRENT_VERSION,
    jobs: [],
    masterResumes: [],
    settings: defaultSettings(),
    companies: [],
  };
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Partial<PersistedState>;
  return {
    version: CURRENT_VERSION,
    jobs: Array.isArray(r.jobs) ? r.jobs.map((j) => normalizeJob(j)) : [],
    masterResumes: Array.isArray(r.masterResumes) ? r.masterResumes.map((m) => normalizeMasterResume(m)) : [],
    settings: normalizeSettings(r.settings),
    companies: [],
  };
}

function loadPersisted(): StoreState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrate(parsed);
    return {
      jobs: migrated.jobs,
      masterResumes: migrated.masterResumes,
      settings: migrated.settings,
      selectedJobId: null,
      initialized: true,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Server-side companies collection helpers                            */
/* ------------------------------------------------------------------ */

const COMPANIES_MIGRATED_FLAG = 'jobboard-companies-migrated-v1';
const COMPANIES_IMPORT_CHUNK = 5000;

interface CompanyImportRow {
  name: string;
  website: string;
  careersUrl?: string;
  category?: string;
  source?: string;
  addedAt?: string;
}

function toImportRow(raw: unknown): CompanyImportRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Partial<Company>;
  const name = String(c.name ?? '').trim();
  const website = String(c.website ?? '').trim();
  if (!name || !website) return null;
  return {
    name,
    website,
    careersUrl: String(c.careersUrl ?? '') || undefined,
    category: String(c.category ?? '') || undefined,
    source: String(c.source ?? '') || undefined,
    addedAt: String(c.addedAt ?? '') || undefined,
  };
}

/** POST rows to /api/companies/import, chunked at 5000. Failures are
 *  swallowed: the import endpoint dedupes server-side, and the migrate
 *  endpoint is the authoritative path for cloud data. */
async function importCompaniesToCollection(rawRows: unknown[]): Promise<void> {
  const key = getSyncKey();
  if (!key) return;
  const rows = rawRows
    .map((r) => toImportRow(r))
    .filter((r): r is CompanyImportRow => r !== null);
  for (let i = 0; i < rows.length; i += COMPANIES_IMPORT_CHUNK) {
    try {
      await fetch('/api/companies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
        body: JSON.stringify({ companies: rows.slice(i, i + COMPANIES_IMPORT_CHUNK) }),
      });
    } catch {
      // Ignored per contract — never fail a restore/migration over this.
    }
  }
}

/** Fetch every company from the collection, paged at limit 100, for a
 *  backup snapshot. On ANY failure returns [] so the caller exports
 *  without companies rather than failing the whole export. */
async function fetchAllCompaniesForBackup(): Promise<Company[]> {
  const key = getSyncKey();
  if (!key) return [];
  const all: Company[] = [];
  try {
    for (;;) {
      const params = new URLSearchParams({ skip: String(all.length), limit: '100', q: '' });
      const r = await fetch(`/api/companies?${params.toString()}`, {
        headers: { 'x-sync-key': key },
      });
      if (!r.ok) return [];
      const data = await r.json();
      const rows = Array.isArray(data.companies) ? (data.companies as Company[]) : [];
      all.push(...rows);
      const total = typeof data.total === 'number' ? data.total : all.length;
      if (rows.length === 0 || all.length >= total) break;
    }
  } catch {
    return [];
  }
  return all;
}

/** One-time legacy migration, run before cloud reconciliation (see the
 *  StoreProvider effect below). (a) Any companies in the locally stored
 *  payload are imported to the collection; (b) POST /api/companies/migrate
 *  moves any companies still in the cloud state doc into the collection and
 *  clears them there. Guarded by a localStorage flag so it runs once per
 *  browser; a network throw leaves the flag unset so the next visit retries,
 *  and re-running is harmless (the server dedupes / the migrate call is
 *  idempotent). No sync key means no migration attempt and no flag. */
async function runCompanyMigrationOnce(): Promise<void> {
  try {
    if (localStorage.getItem(COMPANIES_MIGRATED_FLAG)) return;
  } catch {
    return;
  }
  const key = getSyncKey();
  if (!key) return;
  try {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { companies?: unknown };
        if (Array.isArray(parsed.companies)) {
          await importCompaniesToCollection(parsed.companies);
        }
      }
    } catch {
      // Local import failures are ignored — the migrate endpoint below is
      // the authoritative path for cloud data.
    }
    await fetch('/api/companies/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
      body: JSON.stringify({}),
    });
    try {
      localStorage.setItem(COMPANIES_MIGRATED_FLAG, '1');
    } catch {
      // Storage blocked — migration re-runs next visit; it is idempotent.
    }
  } catch {
    // Network throw: flag stays unset so the next visit retries.
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export type NewJobInput = Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'activities'>;

interface StoreApi extends StoreState {
  dispatch: React.Dispatch<Action>;
  addJob: (input: NewJobInput) => void;
  moveJob: (id: string, toStageId: StageId) => boolean;
  updateJob: (id: string, patch: Partial<Job>, activityText?: string, activityKind?: ActivityKind) => void;
  deleteJob: (id: string) => void;
  addActivityNote: (jobId: string, text: string) => void;
  selectJob: (id: string | null) => void;
  addMasterResume: (input: Omit<MasterResume, 'id' | 'uploadedAt'>) => void;
  deleteMasterResume: (id: string) => void;
  setDefaultMasterResume: (id: string) => void;
  exportBackup: () => void;
  importBackup: (file: File) => Promise<{ ok: boolean; error?: string }>;
  selectedJob: Job | null;
}

const StoreContext = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => loadPersisted() ?? initialState());

  const [cloudReady, setCloudReady] = useState(false);

  // Persist on every change. Waits for the initial cloud check so a fresh
  // device never pushes empty state over real cloud data.
  useEffect(() => {
    if (!state.initialized || !cloudReady) return;
    const payload = {
      version: CURRENT_VERSION,
      jobs: state.jobs,
      masterResumes: state.masterResumes,
      settings: state.settings,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full/blocked — app keeps working in memory.
    }
    pushCloudStateDebounced(payload);
  }, [state, cloudReady]);

  // Cloud reconciliation on load: newest wins (cloud vs local).
  // When cloud sync is on and the cloud is empty, the cloud is still the
  // source of truth — there is no seed data to protect.
  // The legacy companies migration runs FIRST, before any REPLACE_ALL
  // dispatch and before cloudReady lets the persist effect push state:
  // that way a legacy state doc's companies reach the collection exactly
  // once, instead of being overwritten by a companies-free push.
  useEffect(() => {
    (async () => {
      await runCompanyMigrationOnce();
      const cloud = await fetchCloudState();
      if (cloud && cloud.state) {
        let localUpdatedAt = 0;
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) localUpdatedAt = Number(JSON.parse(raw).updatedAt ?? 0) || 0;
        } catch {
          // ignore — treat local as empty
        }
        const cloudUpdatedAt = new Date(cloud.updatedAt).getTime() || 0;
        if (cloudUpdatedAt > localUpdatedAt) {
          const migrated = migrate(cloud.state);
          dispatch({ type: 'REPLACE_ALL', state: migrated });
        }
      }
      setCloudReady(true);
    })();
  }, []);

  // Mark initialized once the cloud check settles (no seed data in JobBoard).
  useEffect(() => {
    if (cloudReady && !state.initialized) {
      dispatch({ type: 'INIT_DONE' });
    }
  }, [cloudReady, state.initialized]);

  const addJob = useCallback((input: NewJobInput) => {
    const ts = nowIso();
    const job: Job = {
      ...input,
      id: uid(),
      activities: [],
      createdAt: ts,
      updatedAt: ts,
    };
    dispatch({ type: 'ADD_JOB', job });
  }, []);

  const moveJob: StoreApi['moveJob'] = useCallback(
    (id, toStageId) => {
      const job = state.jobs.find((j) => j.id === id);
      if (!job) return false;
      const from = findStage(state.settings.stages, job.stageId);
      const to = findStage(state.settings.stages, toStageId);
      const check = canTransition(from, to);
      if (!check.ok) return false;
      dispatch({ type: 'MOVE_JOB', id, toStageId });
      return true;
    },
    [state.jobs, state.settings.stages],
  );

  const updateJob = useCallback<StoreApi['updateJob']>((id, patch, activityText, activityKind) => {
    dispatch({ type: 'UPDATE_JOB', id, patch, activityText, activityKind });
  }, []);

  const deleteJob = useCallback((id: string) => dispatch({ type: 'DELETE_JOB', id }), []);
  const addActivityNote = useCallback(
    (jobId: string, text: string) => dispatch({ type: 'ADD_ACTIVITY_NOTE', jobId, text }),
    [],
  );
  const selectJob = useCallback((id: string | null) => dispatch({ type: 'SELECT_JOB', id }), []);

  const addMasterResume = useCallback((input: Omit<MasterResume, 'id' | 'uploadedAt'>) => {
    const resume: MasterResume = { ...input, id: uid(), uploadedAt: nowIso() };
    dispatch({ type: 'ADD_MASTER_RESUME', resume });
  }, []);
  const deleteMasterResume = useCallback((id: string) => dispatch({ type: 'DELETE_MASTER_RESUME', id }), []);
  const setDefaultMasterResume = useCallback((id: string) => {
    dispatch({ type: 'UPDATE_SETTINGS', patch: { defaultMasterResumeId: id } });
  }, []);

  // Backup snapshots still include companies, fetched paged from the
  // collection — the store no longer holds them. If the fetch fails, the
  // export goes out without companies rather than failing outright.
  const exportBackup = useCallback(() => {
    void (async () => {
      const companies = await fetchAllCompaniesForBackup();
      const payload: PersistedState = {
        version: CURRENT_VERSION,
        jobs: state.jobs,
        masterResumes: state.masterResumes,
        settings: state.settings,
        companies,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jobboard-backup-${todayLocal()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })();
  }, [state]);

  const importBackup = useCallback(async (file: File): Promise<{ ok: boolean; error?: string }> => {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      // Backup companies belong in the collection, not the store: import
      // them first (failures ignored), then restore the rest. The migrated
      // state dispatched below carries no companies (see REPLACE_ALL).
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { companies?: unknown }).companies)
      ) {
        await importCompaniesToCollection((parsed as { companies: unknown[] }).companies);
      }
      const migrated = migrate(parsed);
      dispatch({ type: 'REPLACE_ALL', state: migrated });
      return { ok: true };
    } catch {
      return { ok: false, error: 'That file is not a valid JobBoard backup.' };
    }
  }, []);

  const selectedJob = useMemo(
    () => state.jobs.find((j) => j.id === state.selectedJobId) ?? null,
    [state.jobs, state.selectedJobId],
  );

  const api: StoreApi = useMemo(
    () => ({
      ...state,
      dispatch,
      addJob,
      moveJob,
      updateJob,
      deleteJob,
      addActivityNote,
      selectJob,
      addMasterResume,
      deleteMasterResume,
      setDefaultMasterResume,
      exportBackup,
      importBackup,
      selectedJob,
    }),
    [
      state,
      addJob,
      moveJob,
      updateJob,
      deleteJob,
      addActivityNote,
      selectJob,
      addMasterResume,
      deleteMasterResume,
      setDefaultMasterResume,
      exportBackup,
      importBackup,
      selectedJob,
    ],
  );

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}
