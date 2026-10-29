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
  companyDedupeKey,
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
import { fetchCloudState, pushCloudStateDebounced } from '../sync';

export const STORAGE_KEY = 'jobboard-state-v1';
export const CURRENT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* State + actions                                                     */
/* ------------------------------------------------------------------ */

export interface StoreState {
  jobs: Job[];
  masterResumes: MasterResume[];
  settings: AppSettings;
  companies: Company[];
  selectedJobId: string | null;
  initialized: boolean;
}

export type Action =
  | { type: 'ADD_JOB'; job: Job }
  | { type: 'ADD_COMPANIES'; companies: Company[] }
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
    case 'ADD_COMPANIES': {
      // Dedupe against the DB and within the batch; new rows go first.
      const seen = new Set(state.companies.map((c) => companyDedupeKey(c.name, c.website)));
      const fresh: Company[] = [];
      for (const c of action.companies) {
        const key = companyDedupeKey(c.name, c.website);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(c);
      }
      if (fresh.length === 0) return state;
      return { ...state, companies: [...fresh, ...state.companies] };
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
      return {
        jobs: action.state.jobs,
        masterResumes: action.state.masterResumes,
        settings: action.state.settings,
        companies: action.state.companies,
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
    companies: [],
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

function normalizeCompany(raw: unknown): Company {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Company>;
  return {
    id: typeof c.id === 'string' ? c.id : uid(),
    name: String(c.name ?? ''),
    website: String(c.website ?? ''),
    careersUrl: String(c.careersUrl ?? ''),
    category: String(c.category ?? ''),
    source: String(c.source ?? 'Seed'),
    addedAt: String(c.addedAt ?? nowIso()),
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

/** Migrate any stored payload up to CURRENT_VERSION. Pure & testable. */
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
    companies: Array.isArray(r.companies) ? r.companies.map((c) => normalizeCompany(c)) : [],
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
      companies: migrated.companies,
      selectedJobId: null,
      initialized: true,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export type NewJobInput = Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'activities'>;

interface StoreApi extends StoreState {
  dispatch: React.Dispatch<Action>;
  addJob: (input: NewJobInput) => void;
  addCompanies: (input: Omit<Company, 'id' | 'addedAt'>[]) => void;
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
      companies: state.companies,
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
  useEffect(() => {
    (async () => {
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

  const addCompanies = useCallback((input: Omit<Company, 'id' | 'addedAt'>[]) => {
    const ts = nowIso();
    const companies: Company[] = input.map((c) => ({ ...c, id: uid(), addedAt: ts }));
    dispatch({ type: 'ADD_COMPANIES', companies });
  }, []);

  const addMasterResume = useCallback((input: Omit<MasterResume, 'id' | 'uploadedAt'>) => {
    const resume: MasterResume = { ...input, id: uid(), uploadedAt: nowIso() };
    dispatch({ type: 'ADD_MASTER_RESUME', resume });
  }, []);
  const deleteMasterResume = useCallback((id: string) => dispatch({ type: 'DELETE_MASTER_RESUME', id }), []);
  const setDefaultMasterResume = useCallback((id: string) => {
    dispatch({ type: 'UPDATE_SETTINGS', patch: { defaultMasterResumeId: id } });
  }, []);

  const exportBackup = useCallback(() => {
    const payload: PersistedState = {
      version: CURRENT_VERSION,
      jobs: state.jobs,
      masterResumes: state.masterResumes,
      settings: state.settings,
      companies: state.companies,
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
  }, [state]);

  const importBackup = useCallback(async (file: File): Promise<{ ok: boolean; error?: string }> => {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
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
      addCompanies,
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
      addCompanies,
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
