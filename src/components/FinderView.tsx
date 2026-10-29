import { useMemo, useRef, useState } from 'react';
import { dedupeCompanies, deriveTailoredFileName, jobDedupeKey } from '../domain';
import { useStore } from '../store';
import { getSyncKey } from '../sync';
import { Badge, Button, EmptyState, Input, Select } from './ui';
import type { FinderLead } from '../../api/find-jobs';

const COMPANIES_PER_PAGE = 25;
const JOBS_CHUNK = 15;

interface CompanyResult {
  added: number;
  seedRemaining: number;
  nextOffset: number;
  exhausted: boolean;
  error?: string;
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
  // Wikidata discovery offset, persisted locally so presses keep walking
  // the live result set. Losing it is harmless — the server also filters
  // against the database, so no company is ever returned twice.
  const [discoveryOffset, setDiscoveryOffset] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('jobboard-finder-offset') ?? 0) || 0;
    } catch {
      return 0;
    }
  });
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
      const key = getSyncKey();
      if (!key) {
        setCompanyResult({
          added: 0,
          seedRemaining: 0,
          nextOffset: discoveryOffset,
          exhausted: false,
          error: "Find Companies needs the app's sync key, which isn't set in this build.",
        });
        return;
      }
      const r = await fetch('/api/find-companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
        body: JSON.stringify({ limit: 500, offset: discoveryOffset }),
      });
      if (!r.ok) {
        setCompanyResult({
          added: 0,
          seedRemaining: 0,
          nextOffset: discoveryOffset,
          exhausted: false,
          error:
            r.status === 401
              ? 'Find Companies was not authorized. Check the app sync key and try again.'
              : `Find Companies failed (HTTP ${r.status}). Nothing was lost — press again.`,
        });
        return;
      }
      const data = await r.json();
      const rows = ((data.companies ?? []) as {
        name: string;
        website: string;
        careersUrl: string;
        category: string;
        source: string;
      }[]).map((c) => ({
        name: c.name,
        website: c.website,
        careersUrl: c.careersUrl ?? '',
        category: c.category ?? '',
        source: c.source ?? 'Seed',
      }));
      const { unique } = dedupeCompanies(rows, companies);
      addCompanies(unique);
      const nextOffset = typeof data.nextOffset === 'number' ? data.nextOffset : discoveryOffset;
      setDiscoveryOffset(nextOffset);
      try {
        localStorage.setItem('jobboard-finder-offset', String(nextOffset));
      } catch {
        // Storage blocked — offset resets next visit, but dedupe still prevents repeats.
      }
      setCompanyResult({
        added: unique.length,
        seedRemaining: typeof data.seedRemaining === 'number' ? data.seedRemaining : 0,
        nextOffset,
        exhausted: !!data.exhausted,
        error: typeof data.error === 'string' ? data.error : undefined,
      });
      setCompanyPage(1);
    } catch {
      setCompanyResult({
        added: 0,
        seedRemaining: 0,
        nextOffset: discoveryOffset,
        exhausted: false,
        error: 'Find Companies hit a network error. Nothing was lost — press again.',
      });
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
  const [runSummary, setRunSummary] = useState<{
    found: number;
    added: number;
    already: number;
    manual: number;
    nearMiss: number;
    stopped: boolean;
  } | null>(null);
  const stopRef = useRef(false);
  // Run-scoped bookkeeping (refs because the chunk loop outlives renders).
  const allLeadsRef = useRef<FinderLead[]>([]);
  const startKeysRef = useRef<Set<string>>(new Set());
  const knownRef = useRef<Set<string>>(new Set());
  const autoAddedRef = useRef<Set<string>>(new Set());
  const manualRef = useRef<Set<string>>(new Set());

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
    setRunSummary(null);
    setProgress({ checked: 0, total: 0, errors: 0 });
    allLeadsRef.current = [];
    startKeysRef.current = new Set(boardKeys);
    knownRef.current = new Set(boardKeys);
    autoAddedRef.current = new Set();
    manualRef.current = new Set();
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
            // Search the companies in this database — the API resolves
            // these names against its seed and never takes a URL from us.
            companies: companies.map((c) => c.name),
            cursor,
            limit: JOBS_CHUNK,
          }),
        });
        if (!r.ok) {
          setJobError(
            r.status === 401
              ? 'Job search was not authorized. Check the app sync key and try again.'
              : `Job search failed (HTTP ${r.status}). You can run it again — progress is kept.`,
          );
          break;
        }
        const data = await r.json();
        checked += data.checked ?? 0;
        errors += data.stats?.boardErrors ?? 0;
        setProgress({ checked, total: data.totalCompanies ?? 0, errors });
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          const seen = new Set(allLeadsRef.current.map((l) => l.applyUrl));
          const deduped = (data.leads as FinderLead[]).filter(
            (l) => l.applyUrl && !seen.has(l.applyUrl),
          );
          allLeadsRef.current = [...allLeadsRef.current, ...deduped];
          setLeads(allLeadsRef.current);
          // 60% and up go straight to the Pipeline; under 60% stays here
          // as a near miss for Eric to add by hand.
          for (const lead of deduped) {
            const k = jobDedupeKey(lead.title, lead.company);
            if (lead.matchScore >= 60 && !knownRef.current.has(k)) {
              addLeadToBoard(lead);
              knownRef.current.add(k);
              autoAddedRef.current.add(k);
            }
          }
        }
        if (data.done || data.nextCursor === null || data.nextCursor === undefined) {
          setJobDone(true);
          break;
        }
        cursor = data.nextCursor;
      }
    } catch {
      setJobError('Job search hit a network error. You can run it again — progress is kept.');
    }
    const found = allLeadsRef.current.length;
    const added = autoAddedRef.current.size;
    const already = allLeadsRef.current.filter((l) =>
      startKeysRef.current.has(jobDedupeKey(l.title, l.company)),
    ).length;
    const manual = allLeadsRef.current.filter((l) => {
      const k = jobDedupeKey(l.title, l.company);
      return (
        manualRef.current.has(k) && !startKeysRef.current.has(k) && !autoAddedRef.current.has(k)
      );
    }).length;
    setRunSummary({
      found,
      added,
      already,
      manual,
      nearMiss: Math.max(0, found - added - already - manual),
      stopped: stopRef.current,
    });
    setSearching(false);
  }

  function addLeadToBoard(lead: FinderLead) {
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
  }

  function handleAddToBoard(lead: FinderLead) {
    const k = jobDedupeKey(lead.title, lead.company);
    addLeadToBoard(lead);
    setAddedKeys((prev) => new Set(prev).add(k));
    manualRef.current.add(k);
    knownRef.current.add(k);
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
                  {' · '}
                  {companyResult.added} added just now
                  {companyResult.error ? (
                    <> · {companyResult.error}</>
                  ) : companyResult.exhausted ? (
                    <> · No more companies found from current sources</>
                  ) : companyResult.seedRemaining > 0 ? (
                    <> · {companyResult.seedRemaining} verified seed companies left</>
                  ) : (
                    <> · Discovering from live sources — press again for 500 more</>
                  )}
                </>
              )}
            </p>
          </div>
          <Button variant="primary" onClick={handleFindCompanies} disabled={findingCompanies}>
            {findingCompanies ? 'Finding companies…' : 'Find Companies'}
          </Button>
        </div>
        <p className="text-sm text-zinc-400">
          Find Companies finds companies not already in your database — verified seed companies
          first, then live discovery — at most 500 new ones per click. Press it again for the
          next batch; it never duplicates, and it keeps finding new ones until every source is
          exhausted.
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
              Searches the companies in your database for remote roles matching the resume you
              pick. Matches at 60% and up go straight to your Pipeline; every result links to the
              real application.
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
              disabled={!selectedResume || searching || companies.length === 0}
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
              disabled={searching}
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
        {masterResumes.length > 0 && companies.length === 0 && (
          <p className="text-sm text-amber-400">
            Run Find Companies first — Find Jobs searches the companies in your database.
          </p>
        )}
        {runSummary && !searching && (
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <p className="text-sm text-zinc-100">
              Found {runSummary.found} {runSummary.found === 1 ? 'job' : 'jobs'} · Added{' '}
              {runSummary.added} to your Pipeline
              {runSummary.already > 0 && <> · {runSummary.already} already on your board</>}
              {runSummary.manual > 0 && <> · {runSummary.manual} added by hand</>}
              {runSummary.nearMiss > 0 && (
                <> · {runSummary.nearMiss} near-misses (under 60%) not added</>
              )}
              {runSummary.stopped && <> · Stopped early</>}
            </p>
          </div>
        )}

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
          it can't read are skipped, not guessed at. Jobs scoring 60% and up are added to your
          Pipeline automatically; near misses stay here for you to add by hand. Nothing ever
          auto-applies, and tailored resumes are still made only when you ask.
        </p>
      </section>
    </div>
  );
}
