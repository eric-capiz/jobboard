import { useMemo, useRef, useState } from 'react';
import { dedupeCompanies, deriveTailoredFileName, jobDedupeKey } from '../domain';
import { useStore } from '../store';
import { getSyncKey } from '../sync';
import { Badge, Button, EmptyState, Input, Select } from './ui';
import type { FinderLead } from '../../api/find-jobs';

const COMPANIES_PER_PAGE = 25;
const JOBS_CHUNK = 15;

interface CompanyResult {
  seedTotal: number;
  added: number;
  already: number;
  total: number;
}

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 60 ? 'green' : 'amber';
  return (
    <Badge tone={tone}>
      {score}%{score < 60 ? ' · Near miss' : ''}
    </Badge>
  );
}

export function FinderView() {
  const { companies, jobs, masterResumes, settings, addCompanies, addJob } = useStore();

  /* ---------------- Companies ---------------- */
  const [findingCompanies, setFindingCompanies] = useState(false);
  const [companyResult, setCompanyResult] = useState<CompanyResult | null>(null);
  const [companyQuery, setCompanyQuery] = useState('');
  const [companyPage, setCompanyPage] = useState(1);

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );
  const filteredCompanies = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    if (!q) return sortedCompanies;
    return sortedCompanies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        c.website.toLowerCase().includes(q),
    );
  }, [sortedCompanies, companyQuery]);
  const companyPageCount = Math.max(1, Math.ceil(filteredCompanies.length / COMPANIES_PER_PAGE));
  const companyPageRows = filteredCompanies.slice(
    (companyPage - 1) * COMPANIES_PER_PAGE,
    companyPage * COMPANIES_PER_PAGE,
  );

  async function handleFindCompanies() {
    setFindingCompanies(true);
    try {
      // Seed loads on demand so the main bundle stays small.
      const { COMPANIES_SEED } = await import('../../api/companies-seed');
      const rows = COMPANIES_SEED.map((s) => ({
        name: s.n,
        website: s.w,
        careersUrl: s.c,
        category: s.g,
        source: 'Seed',
      }));
      const { unique, skipped } = dedupeCompanies(rows, companies);
      addCompanies(unique);
      setCompanyResult({
        seedTotal: rows.length,
        added: unique.length,
        already: skipped,
        total: companies.length + unique.length,
      });
      setCompanyPage(1);
    } finally {
      setFindingCompanies(false);
    }
  }

  /* ---------------- Jobs ---------------- */
  const [resumeId, setResumeId] = useState<string>(
    () => settings.defaultMasterResumeId || masterResumes[0]?.id || '',
  );
  const selectedResume =
    masterResumes.find((r) => r.id === resumeId) ?? masterResumes[0] ?? null;
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState({ checked: 0, total: 0, errors: 0 });
  const [leads, setLeads] = useState<FinderLead[]>([]);
  const [jobError, setJobError] = useState('');
  const [jobDone, setJobDone] = useState(false);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const stopRef = useRef(false);

  const boardKeys = useMemo(
    () => new Set(jobs.map((j) => jobDedupeKey(j.title, j.company))),
    [jobs],
  );
  const sortedLeads = useMemo(() => [...leads].sort((a, b) => b.matchScore - a.matchScore), [leads]);

  async function handleFindJobs() {
    if (!selectedResume || searching) return;
    stopRef.current = false;
    setSearching(true);
    setJobError('');
    setJobDone(false);
    setLeads([]);
    setProgress({ checked: 0, total: 0, errors: 0 });
    const key = getSyncKey();
    if (!key) {
      setJobError("Job search needs the app's sync key, which isn't set in this build.");
      setSearching(false);
      return;
    }
    let cursor = 0;
    let checked = 0;
    let errors = 0;
    try {
      for (;;) {
        if (stopRef.current) break;
        const r = await fetch('/api/find-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
          body: JSON.stringify({
            resumeText: selectedResume.text,
            cursor,
            limit: JOBS_CHUNK,
          }),
        });
        if (!r.ok) {
          setJobError(
            r.status === 401
              ? 'Job search was not authorized. Check the app sync key and try again.'
              : `Job search failed (HTTP ${r.status}). You can resume — progress is kept.`,
          );
          break;
        }
        const data = await r.json();
        checked += data.checked ?? 0;
        errors += data.stats?.boardErrors ?? 0;
        setProgress({ checked, total: data.totalCompanies ?? 0, errors });
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          setLeads((prev) => {
            const seen = new Set(prev.map((l) => l.applyUrl));
            const fresh = (data.leads as FinderLead[]).filter((l) => l.applyUrl && !seen.has(l.applyUrl));
            return [...prev, ...fresh];
          });
        }
        if (data.done || data.nextCursor === null || data.nextCursor === undefined) {
          setJobDone(true);
          break;
        }
        cursor = data.nextCursor;
      }
    } catch {
      setJobError('Job search hit a network error. You can run it again — progress is kept.');
    } finally {
      setSearching(false);
    }
  }

  function handleAddToBoard(lead: FinderLead) {
    if (!selectedResume) return;
    addJob({
      title: lead.title,
      company: lead.company,
      location: lead.location,
      salaryText: lead.salaryText,
      source: 'Career Page',
      postedDate: lead.postedDate,
      applyUrl: lead.applyUrl,
      description: lead.description,
      matchScore: lead.matchScore,
      strengths: lead.strengths,
      gaps: lead.gaps,
      masterResumeName: selectedResume.label,
      tailoredResumeText: '',
      tailoredFileName: deriveTailoredFileName(lead.company),
      stageId: 'new',
      notes: 'Found via Finder.',
    });
    setAddedKeys((prev) => new Set(prev).add(jobDedupeKey(lead.title, lead.company)));
  }

  return (
    <div className="space-y-10">
      {/* ---------------- Companies ---------------- */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-100">Finder</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              {companies.length} {companies.length === 1 ? 'company' : 'companies'} in your database
              {companyResult && (
                <>
                  {' · '}Seed has {companyResult.seedTotal} verified companies ·{' '}
                  {companyResult.added} added just now · {companyResult.already} already in your
                  database
                </>
              )}
            </p>
          </div>
          <Button variant="primary" onClick={handleFindCompanies} disabled={findingCompanies}>
            {findingCompanies ? 'Finding companies…' : 'Find Companies'}
          </Button>
        </div>
        <p className="text-sm text-zinc-400">
          Find Companies pulls in verified companies — ones with a real careers page — and stores
          only the ones not already in your database. Press it again any time; it never duplicates.
        </p>

        {companies.length === 0 ? (
          <EmptyState
            title="No companies yet"
            description="Press Find Companies to load the verified company database. Then Find Jobs searches those companies' careers pages."
            action={
              <Button variant="primary" onClick={handleFindCompanies} disabled={findingCompanies}>
                Find Companies
              </Button>
            }
          />
        ) : (
          <>
            <div className="w-full sm:w-64">
              <Input
                value={companyQuery}
                onChange={(e) => {
                  setCompanyQuery(e.target.value);
                  setCompanyPage(1);
                }}
                placeholder="Search companies…"
                aria-label="Search companies"
              />
            </div>
            {filteredCompanies.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                No companies match “{companyQuery}”.
              </p>
            ) : (
              <>
                <p className="text-xs text-zinc-500">
                  Showing {(companyPage - 1) * COMPANIES_PER_PAGE + 1}–
                  {(companyPage - 1) * COMPANIES_PER_PAGE + companyPageRows.length} of{' '}
                  {filteredCompanies.length}
                </p>
                <div className="overflow-hidden rounded-2xl border border-white/10">
                  {companyPageRows.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/5 bg-zinc-900/60 px-4 py-3 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 text-sm font-medium text-zinc-100">
                        {c.name}
                      </span>
                      <span className="text-xs text-zinc-500">{c.category}</span>
                      <a
                        href={c.website}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline"
                      >
                        Website
                      </a>
                      {c.careersUrl && (
                        <a
                          href={c.careersUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline"
                        >
                          Careers
                        </a>
                      )}
                    </div>
                  ))}
                </div>
                {companyPageCount > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={companyPage <= 1}
                      onClick={() => setCompanyPage((p) => p - 1)}
                    >
                      ← Prev
                    </Button>
                    <span className="text-xs text-zinc-500">
                      Page {companyPage} of {companyPageCount}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={companyPage >= companyPageCount}
                      onClick={() => setCompanyPage((p) => p + 1)}
                    >
                      Next →
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* ---------------- Jobs ---------------- */}
      <section className="space-y-5 border-t border-white/10 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-zinc-100">Find Jobs</h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Searches your companies' careers pages for remote roles matching the resume you pick.
              Every result links straight to the real application.
            </p>
          </div>
          <div className="flex gap-2">
            {searching && (
              <Button
                variant="secondary"
                onClick={() => {
                  stopRef.current = true;
                }}
              >
                Stop
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleFindJobs}
              disabled={!selectedResume || searching}
            >
              {searching ? 'Searching…' : 'Find Jobs'}
            </Button>
          </div>
        </div>

        {masterResumes.length === 0 ? (
          <EmptyState
            title="No resume to match against"
            description="Upload a master resume in Resumes first — Find Jobs reads its skills and titles to find matching roles."
          />
        ) : (
          <div className="w-full sm:w-72">
            <Select
              label="Resume to match"
              value={selectedResume?.id ?? ''}
              onChange={(e) => setResumeId(e.target.value)}
            >
              {masterResumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
        )}

        {(searching || leads.length > 0 || jobDone) && (
          <p className="text-sm text-zinc-400">
            Checked {progress.checked}
            {progress.total > 0 && ` of ${progress.total}`} companies · {leads.length}{' '}
            {leads.length === 1 ? 'lead' : 'leads'}
            {progress.errors > 0 && ` · ${progress.errors} boards unreachable`}
            {jobDone && ' · Done'}
            {searching && ' · Running — results appear as they are found.'}
          </p>
        )}
        {jobError && <p className="text-sm text-red-400">{jobError}</p>}

        {sortedLeads.length > 0 && (
          <div className="space-y-3">
            {sortedLeads.map((lead) => {
              const key = jobDedupeKey(lead.title, lead.company);
              const onBoard = boardKeys.has(key) || addedKeys.has(key);
              return (
                <div
                  key={lead.applyUrl}
                  className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold leading-snug text-zinc-100">
                        {lead.title}
                      </h3>
                      <p className="mt-0.5 text-sm text-zinc-400">
                        {lead.company} · {lead.location}
                        {lead.salaryText && ` · ${lead.salaryText}`}
                      </p>
                    </div>
                    <ScoreBadge score={lead.matchScore} />
                  </div>
                  {lead.locationFlag && (
                    <p className="mt-1 text-xs text-zinc-500">{lead.locationFlag}</p>
                  )}
                  {lead.description && (
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                      {lead.description.slice(0, 280)}
                      {lead.description.length > 280 && '…'}
                    </p>
                  )}
                  {(lead.strengths.length > 0 || lead.gaps.length > 0) && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {lead.strengths.map((s) => (
                        <Badge key={`s-${s}`} tone="green">
                          {s}
                        </Badge>
                      ))}
                      {lead.gaps.map((g) => (
                        <Badge key={`g-${g}`} tone="red">
                          Gap: {g}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a href={lead.applyUrl} target="_blank" rel="noreferrer">
                      <Button variant="primary" size="sm">
                        Apply →
                      </Button>
                    </a>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={onBoard}
                      onClick={() => handleAddToBoard(lead)}
                    >
                      {onBoard ? 'On board ✓' : 'Add to board'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {jobDone && leads.length === 0 && !jobError && (
          <p className="py-6 text-center text-sm text-zinc-500">
            No remote roles matching this resume were found on the companies' boards this run.
          </p>
        )}
        <p className="text-xs text-zinc-600">
          Method: the search reads each company's own careers board (Greenhouse, Lever, Ashby, or
          the board linked from its careers page) — never aggregators. Companies on custom boards
          it can't read are skipped, not guessed at. Nothing is added to your pipeline until you
          press Add to board, and nothing ever auto-applies.
        </p>
      </section>
    </div>
  );
}
