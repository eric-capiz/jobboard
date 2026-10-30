import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveTailoredFileName, jobDedupeKey, type Company } from '../domain';
import { useStore } from '../store';
import { getSyncKey } from '../sync';
import { Badge, Button, EmptyState, Input, Select } from './ui';
import type { FinderLead } from '../../api/find-jobs';

const COMPANIES_PER_PAGE = 25;
const JOBS_CHUNK = 15;

interface CompanyResult {
  added: number;
  total: number;
  source?: string;
  exhausted: boolean;
  error?: string;
  note?: string;
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
  const { jobs, masterResumes, settings, addJob } = useStore();

  /* ---------------- Companies (server collection) ---------------- */
  const [findingCompanies, setFindingCompanies] = useState(false);
  const [findingCount, setFindingCount] = useState(0);
  const [companyResult, setCompanyResult] = useState<CompanyResult | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [totalCompanies, setTotalCompanies] = useState(0);
  const [companyError, setCompanyError] = useState('');
  const [companyQuery, setCompanyQuery] = useState('');
  const [companyPage, setCompanyPage] = useState(1);

  // The discovery cursor moved server-side: the server holds it now, so the
  // old client offset is dead state. Delete it once so it never comes back.
  useEffect(() => {
    try {
      localStorage.removeItem('jobboard-finder-offset-v2');
    } catch {
      // Storage blocked — the key is simply never read again.
    }
  }, []);

  const loadCompanies = useCallback(async (page: number, query: string) => {
    try {
      const key = getSyncKey();
      const params = new URLSearchParams({
        skip: String((page - 1) * COMPANIES_PER_PAGE),
        limit: String(COMPANIES_PER_PAGE),
        q: query.trim(),
      });
      const r = await fetch(`/api/companies?${params.toString()}`, {
        headers: key ? { 'x-sync-key': key } : {},
      });
      if (!r.ok) {
        setCompanyError(
          r.status === 401
            ? 'Company list was not authorized. Check the app sync key and try again.'
            : `Could not load companies (HTTP ${r.status}).`,
        );
        return;
      }
      const data = await r.json();
      setCompanies(Array.isArray(data.companies) ? (data.companies as Company[]) : []);
      setTotalCompanies(typeof data.total === 'number' ? data.total : 0);
      setCompanyError('');
    } catch {
      // Keep the current list on a network error; only the error line changes.
      setCompanyError('Could not load companies (network error).');
    }
  }, []);

  // Load page 1 on mount, and reload whenever the page or search query changes.
  useEffect(() => {
    void loadCompanies(companyPage, companyQuery);
  }, [companyPage, companyQuery, loadCompanies]);

  const companyPageCount = Math.max(1, Math.ceil(totalCompanies / COMPANIES_PER_PAGE));

  async function handleFindCompanies() {
    setFindingCompanies(true);
    setFindingCount(0);
    // One press finds exactly 100 new companies. A single server call
    // cannot fit that many inside the ~60s function limit, so the press
    // loops: each call inserts what it found and advances the server-side
    // cursor, and the press keeps going until exactly 100 new companies
    // are in, the sources are exhausted, or a call fails. The server
    // caps inserts at the requested limit per call (banking any excess
    // for the next call), so the loop converges exactly — it can never
    // overshoot. Companies found before a failure or exhaustion stay
    // found — a press never loses progress.
    const EXACT_PER_PRESS = 100;
    const MAX_CALLS_PER_PRESS = 30;
    let accumulated = 0;
    let total = totalCompanies;
    let source: string | undefined;
    let exhausted = false;
    let error: string | undefined;
    let note: string | undefined;
    try {
      const key = getSyncKey();
      if (!key) {
        setCompanyResult({
          added: 0,
          total,
          exhausted: false,
          error: "Find Companies needs the app's sync key, which isn't set in this build.",
        });
        return;
      }
      for (
        let call = 0;
        call < MAX_CALLS_PER_PRESS && accumulated < EXACT_PER_PRESS && !exhausted && !error;
        call += 1
      ) {
        let r: Response;
        try {
          r = await fetch('/api/find-companies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
            // No offset: the server holds the discovery cursor and inserts
            // new companies into the collection during the call. The
            // response carries no company rows — the list is refreshed from
            // GET /api/companies below.
            body: JSON.stringify({ limit: EXACT_PER_PRESS - accumulated }),
          });
        } catch {
          error = 'Find Companies hit a network error. Nothing was lost — press again.';
          break;
        }
        if (!r.ok) {
          error =
            r.status === 401
              ? 'Find Companies was not authorized. Check the app sync key and try again.'
              : `Find Companies failed (HTTP ${r.status}). Nothing was lost — press again.`;
          break;
        }
        let data: {
          added?: unknown;
          total?: unknown;
          source?: unknown;
          exhausted?: unknown;
          error?: unknown;
          note?: unknown;
        };
        try {
          data = await r.json();
        } catch {
          error = 'Find Companies got an unreadable response. Nothing was lost — press again.';
          break;
        }
        const added = typeof data.added === 'number' ? data.added : 0;
        accumulated += added;
        setFindingCount(accumulated);
        if (typeof data.total === 'number') total = data.total;
        if (typeof data.source === 'string') source = data.source;
        if (typeof data.error === 'string') error = data.error;
        if (typeof data.note === 'string') note = data.note;
        if (data.exhausted) exhausted = true;
      }
      if (!exhausted && !error && accumulated < EXACT_PER_PRESS) {
        note = `Stopped after ${MAX_CALLS_PER_PRESS} calls with ${accumulated} found — press again to continue.`;
      }
      setCompanyResult({ added: accumulated, total, source, exhausted, error, note });
      if (accumulated > 0) {
        // The new rows live in the collection now — reset to page 1 and reload.
        setCompanyPage(1);
        await loadCompanies(1, companyQuery);
      }
    } catch {
      setCompanyResult({
        added: accumulated,
        total,
        exhausted,
        error: error ?? 'Find Companies hit an unexpected error. Nothing was lost — press again.',
        note,
      });
      if (accumulated > 0) {
        setCompanyPage(1);
        await loadCompanies(1, companyQuery);
      }
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
          // The server pages the companies collection itself — the client
          // sends only the resume text and the collection cursor, never a
          // companies array.
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

  const showEmptyState = totalCompanies === 0 && companyQuery.trim() === '';

  return (
    <div className="space-y-10">
      {/* ---------------- Companies ---------------- */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-100">Finder</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              {totalCompanies} {totalCompanies === 1 ? 'company' : 'companies'} in your database
              {companyResult && (
                <>
                  {' · '}
                  {companyResult.added} added just now
                  {companyResult.source ? <> · {companyResult.source}</> : null}
                  {companyResult.total > 0 ? <> · {companyResult.total} total</> : null}
                  {companyResult.error ? (
                    <> · {companyResult.error}</>
                  ) : companyResult.note ? (
                    <> · {companyResult.note}</>
                  ) : companyResult.exhausted ? (
                    <> · No more companies found from current sources</>
                  ) : (
                    <> · Discovered live — press again for more</>
                  )}
                </>
              )}
            </p>
          </div>
          <Button variant="primary" onClick={handleFindCompanies} disabled={findingCompanies}>
            {findingCompanies ? `Finding companies… (${findingCount}/100)` : 'Find Companies'}
          </Button>
        </div>
        <p className="text-sm text-zinc-400">
          Find Companies discovers companies not already in your database, live, exactly 100
          new ones per click. Press it again for the next batch; it never duplicates, and it
          keeps finding new ones until every source is exhausted.
        </p>
        {companyError && <p className="text-sm text-red-400">{companyError}</p>}

        {showEmptyState ? (
          <EmptyState
            title="No companies yet"
            description="Press Find Companies to discover companies live. Then Find Jobs searches those companies' careers pages."
            action={
              <Button variant="primary" onClick={handleFindCompanies} disabled={findingCompanies}>
                {findingCompanies ? `Finding companies… (${findingCount}/100)` : 'Find Companies'}
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
            {companies.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                No companies match “{companyQuery}”.
              </p>
            ) : (
              <>
                <p className="text-xs text-zinc-500">
                  Showing {(companyPage - 1) * COMPANIES_PER_PAGE + 1}–
                  {(companyPage - 1) * COMPANIES_PER_PAGE + companies.length} of{' '}
                  {totalCompanies}
                </p>
                <div className="overflow-hidden rounded-2xl border border-white/10">
                  {companies.map((c) => (
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
              disabled={!selectedResume || searching || totalCompanies === 0}
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
        {masterResumes.length > 0 && totalCompanies === 0 && (
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
