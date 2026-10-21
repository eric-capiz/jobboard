import { Job, Stage } from './index';

export type SortKey = 'recent' | 'match' | 'posted' | 'title';

export interface JobFilters {
  query: string;
  sources: string[];
  stages: string[];
  /** Minimum match score, 0–100. 0 means "any". */
  minMatch: number;
  sort: SortKey;
}

export const EMPTY_FILTERS: JobFilters = {
  query: '',
  sources: [],
  stages: [],
  minMatch: 0,
  sort: 'recent',
};

function matchesQuery(job: Job, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [job.title, job.company, job.location, job.notes];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

/** Pure job filtering + sorting for the pipeline view. */
export function filterJobs(jobs: Job[], filters: JobFilters, stages: Stage[]): Job[] {
  const filtered = jobs.filter((job) => {
    if (!matchesQuery(job, filters.query)) return false;
    if (filters.sources.length > 0 && !filters.sources.includes(job.source)) return false;
    if (filters.stages.length > 0 && !filters.stages.includes(job.stageId)) return false;
    if (filters.minMatch > 0 && job.matchScore < filters.minMatch) return false;
    return true;
  });

  void stages;
  const sorted = [...filtered];
  switch (filters.sort) {
    case 'match':
      sorted.sort((a, b) => b.matchScore - a.matchScore);
      break;
    case 'posted':
      sorted.sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));
      break;
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'recent':
    default:
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
  }
  return sorted;
}

export function allSources(jobs: Job[]): string[] {
  const set = new Set<string>();
  for (const j of jobs) if (j.source) set.add(j.source);
  return [...set].sort((a, b) => a.localeCompare(b));
}
