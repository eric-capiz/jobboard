/* Industry classification for JobBoard.
 *
 * Jobs don't carry an industry field, so companies are classified here.
 * Keys are company names normalized (lowercase, trimmed). Any company not
 * listed falls back to "Other" — add new finds here when they are imported. */
import type { Job, Stage } from '../domain';

export const FALLBACK_INDUSTRY = 'Other';

const COMPANY_INDUSTRY: Record<string, string> = {
  'ai2cyber': 'Cybersecurity',
  'affirm': 'Finance & Fintech',
  'aidaptive': 'AI & Machine Learning',
  'allstate': 'Insurance',
  'amgen': 'Pharmaceuticals & Biotech',
  'anlatan': 'AI & Machine Learning',
  'appmysite': 'Technology & SaaS',
  'axios': 'Media & Publishing',
  'bjak': 'Insurance',
  'booz allen hamilton': 'Defense & Government',
  'caci': 'Defense & Government',
  'capital one': 'Finance & Fintech',
  'circlein': 'Education Tech',
  'coinbase': 'Crypto & Web3',
  'commit': 'Staffing & Recruiting',
  'companycam': 'Construction Tech',
  'cresta': 'AI & Machine Learning',
  'customertimes': 'Technology & SaaS',
  'cvs health': 'Healthcare & Health Tech',
  'delta air lines': 'Hospitality, Travel & Food',
  'dualentry': 'Finance & Fintech',
  'ethereum community fund': 'Crypto & Web3',
  'everest technologies': 'Staffing & Recruiting',
  'fintros': 'Finance & Fintech',
  'ford': 'Transportation & Logistics',
  'forloop.ai': 'AI & Machine Learning',
  'gbi': 'Finance & Fintech',
  'general dynamics it': 'Defense & Government',
  'ginas tech jobs': 'Staffing & Recruiting',
  'happy money': 'Finance & Fintech',
  'hims & hers': 'Healthcare & Health Tech',
  'hivex': 'Staffing & Recruiting',
  'human power bg': 'Staffing & Recruiting',
  'humana': 'Insurance',
  'io tech solutions limited': 'Staffing & Recruiting',
  'ipsator': 'Technology & SaaS',
  'jobs for humanity': 'Staffing & Recruiting',
  'kobold metals': 'Mining & Energy',
  'lemon.io': 'Staffing & Recruiting',
  'letsventure': 'Finance & Fintech',
  'madiff': 'Staffing & Recruiting',
  'marriott international': 'Hospitality, Travel & Food',
  'mena alliances': 'Staffing & Recruiting',
  'mercor': 'Staffing & Recruiting',
  'motional': 'Transportation & Logistics',
  'native': FALLBACK_INDUSTRY,
  'nearshore business solutions': 'Staffing & Recruiting',
  'nexora': FALLBACK_INDUSTRY,
  'nomina': FALLBACK_INDUSTRY,
  'ntt data': 'Technology & SaaS',
  'onhires': 'Staffing & Recruiting',
  'oowlish technology': 'Technology & SaaS',
  'ooqia s.a.': FALLBACK_INDUSTRY,
  'peraton': 'Defense & Government',
  'perena': 'Crypto & Web3',
  'pradeepit consulting services pvt ltd': 'Staffing & Recruiting',
  'prodev': 'Staffing & Recruiting',
  'reddit': 'Media & Publishing',
  'saic': 'Defense & Government',
  'schneider national': 'Transportation & Logistics',
  'shopistry': 'Retail & E-commerce',
  'smartsheet': 'Technology & SaaS',
  'startale': 'Crypto & Web3',
  'startup talents': 'Staffing & Recruiting',
  'stateside': 'Staffing & Recruiting',
  'talent journey': 'Staffing & Recruiting',
  'toast': 'Hospitality, Travel & Food',
  'transilvaniahr': 'Staffing & Recruiting',
  'treehouse strategy and communications': 'Marketing & Communications',
  'tripsuite': 'Hospitality, Travel & Food',
  'truelogic': 'Staffing & Recruiting',
  'unifonic': 'Technology & SaaS',
  'unitedhealth group': 'Healthcare & Health Tech',
  'uvation': 'Technology & SaaS',
  'veilant': FALLBACK_INDUSTRY,
  'wow remote teams': 'Staffing & Recruiting',
  'xperteez technology': 'Staffing & Recruiting',
  'zoo corporation': 'Technology & SaaS',
};

export function industryForCompany(company: string): string {
  const key = (company ?? '').trim().toLowerCase();
  return COMPANY_INDUSTRY[key] ?? FALLBACK_INDUSTRY;
}

export interface IndustryStats {
  name: string;
  jobCount: number;
  companyCount: number;
  /** Mean match score across scored jobs (score > 0); null when none scored. */
  avgMatch: number | null;
  /** Highest match score in the industry; null when none scored. */
  bestMatch: number | null;
  /** Stage name -> count, only stages with at least one job, pipeline order. */
  stageBreakdown: { stageName: string; count: number }[];
  /** Companies with the most jobs in this industry (up to 3). */
  topCompanies: string[];
}

/** Aggregate jobs into per-industry stats, biggest industries first. */
export function industryStats(jobs: Job[], stages: Stage[]): IndustryStats[] {
  const byIndustry = new Map<string, Job[]>();
  for (const job of jobs) {
    const name = industryForCompany(job.company);
    const list = byIndustry.get(name);
    if (list) list.push(job);
    else byIndustry.set(name, [job]);
  }

  const stats: IndustryStats[] = [];
  for (const [name, list] of byIndustry.entries()) {
    const companies = new Map<string, number>();
    for (const j of list) companies.set(j.company, (companies.get(j.company) ?? 0) + 1);
    const scored = list.filter((j) => j.matchScore > 0);
    const stageBreakdown = stages
      .map((s) => ({
        stageName: s.name,
        count: list.filter((j) => j.stageId === s.id).length,
      }))
      .filter((s) => s.count > 0);
    stats.push({
      name,
      jobCount: list.length,
      companyCount: companies.size,
      avgMatch:
        scored.length === 0
          ? null
          : Math.round(scored.reduce((sum, j) => sum + j.matchScore, 0) / scored.length),
      bestMatch: scored.length === 0 ? null : Math.max(...scored.map((j) => j.matchScore)),
      stageBreakdown,
      topCompanies: [...companies.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([company]) => company),
    });
  }

  return stats.sort((a, b) => b.jobCount - a.jobCount || a.name.localeCompare(b.name));
}
