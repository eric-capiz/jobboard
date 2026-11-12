/* Local Chromium reproduction of the generic gate resolver.
 *
 * Runs the REAL render path (real Chromium via @sparticuz/chromium-min +
 * puppeteer-core, real renderPageHtml / tryPortalSearch) against mock
 * portal pages served from localhost — no Vercel, no employer sites, no
 * live API. Fixtures mirror the live shapes:
 *   A. index.html — country-picker modal portal (the Foundever shape):
 *      cookie banner + "Find a job in your country" toggle -> JS-built
 *      modal -> "United States (USA)" link -> results-us.html, which
 *      carries "Results 1 – 10 of 34", 4 US job cards, and a qualifying
 *      search box whose form leads to search.html (the global/clobber
 *      page with Budapest roles). The round-14 rule must land on the US
 *      page and never submit there.
 *   B. select.html — native <select> region dropdown (JS reveals results
 *      on change). Exercises pickSelectOption in a real browser.
 *   C. ttec.html — TalentBrew search page (Strategy D shape): 8
 *      class-less <a data-job-id> cards in plain HTML; 1 US CS lead,
 *      4 location rejects, 3 no-match. No render needed.
 *   D. alorica.html — bling-ai portal shell: combobox search box
 *      (described, not named) + "NOW HIRING • 12 OPEN ROLES"; submit
 *      -> alorica-results.html with 3 CS leads + 1 non-CS role.
 *      D0. alorica-zero.html — same shell, 0 open roles; submit ->
 *      alorica-zero-results.html ("Results 0 – 0 of 0", no cards):
 *      outcome must read no-results, 0 leads.
 *   E. sitel.html — landing page whose nav links to jobs-portal.html
 *      (a copy of the Foundever shape): the walk must discover the
 *      portal link and the gate must drive it to the US results.
 *   F1. omni.html — WordPress-style homepage: header site search
 *      (name="s", action = same page) + a "Select your country"
 *      custom dropdown. The site search eats the first submit; the
 *      gate must still be driven after it.
 *   F2. omni-links.html — same homepage, but the countries are bare
 *      footer links (no dropdown container). The US link must be
 *      pickable as a bare locale link.
 *   G. tp.html — marketing homepage with ONE featured role (a teaser)
 *      + a "JOB OPPORTUNITIES" link -> tp-jobs.html, a custom
 *      dropdown whose US pick reveals results inline (JS template).
 *   H. kelly.html — Workday-style shell: cookie banner + keyword box,
 *      cards injected by JS after load; 4 non-CS roles, 0 leads is
 *      the CORRECT outcome.
 *   I. nexrep.html — marketing careers page linking to
 *      paylocity-jobs.html (4 non-CS internal roles); 0 leads is
 *      correct.
 *   J. ws.html — WordPress homepage (site search + "Apply Now" link)
 *      -> ws-jobs.html (3 non-CS roles); 0 leads is correct.
 *
 * Run: esbuild local-verify/driver.ts --bundle --platform=node
 *        --format=cjs --external:mongodb --outfile=/tmp/local-driver.cjs
 *      then: python3 -m http.server 8811 --bind 127.0.0.1
 *        --directory local-verify/fixtures  (background)
 *      then: node /tmp/local-driver.cjs
 */

import { readFileSync } from 'node:fs';
import { searchCompanyJobs } from '../api/find-jobs.js';
import { renderPageHtml } from '../api/render-page.js';

const RESUME = readFileSync(
  '/home/hatch/workspace/jobboard/sweep-2026-11-11-cs-v4/resume.txt',
  'utf-8',
);
const BASE = 'http://127.0.0.1:8811';

let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

type Lead = { title: string; matchScore: number };
type Attempt = {
  searchCountryClicked?: string | null;
  searchGateClicked?: string | null;
  searchToggleClicked?: string | null;
  renderedUrl?: string;
  outcome?: string | null;
  target?: string;
};
type CaseResult = {
  leads?: Lead[];
  postingsSeen?: number;
  searchOutcome?: string | null;
  renderedUrl?: string;
  sourcePage?: string | null;
  renderUsed?: boolean;
  renderAttempted?: boolean;
  screened?: {
    rejectedNoMatch?: number;
    rejectedLocation?: number;
    reviewLocation?: number;
    rejected?: { title: string; location: string; reason: string }[];
  };
  renderAttempts?: Attempt[];
  renderTargets?: { url: string; score: number }[];
};

async function runCase(label: string, website: string, careersUrl?: string): Promise<CaseResult> {
  const result = (await searchCompanyJobs(
    // The entry page is the careers page for portal fixtures; for a
    // homepage entry (TP) the careers URL is empty — passing the
    // homepage as the careers URL would make its featured role count
    // as the list and the walk would never reach the portal.
    { name: label, website, careersUrl: careersUrl ?? website },
    RESUME,
    { renderPage: renderPageHtml, renderBudget: { used: 0, max: 2 } },
  )) as unknown as CaseResult;
  return result;
}

function summarize(label: string, r: CaseResult): void {
  const leads = (r.leads ?? []).map((l) => `${l.title} (${l.matchScore})`);
  // eslint-disable-next-line no-console
  console.log(
    `${label} leads: ${JSON.stringify(leads)} | postings: ${r.postingsSeen} | outcome: ${r.searchOutcome} | renderedUrl: ${r.renderedUrl} | source: ${r.sourcePage} | renderUsed: ${r.renderUsed} | rejected: ${JSON.stringify(r.screened)}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `${label} attempts: ${JSON.stringify(
      (r.renderAttempts ?? []).map((x) => ({
        t: x.target?.replace(BASE, ''),
        o: x.outcome,
        tog: x.searchToggleClicked,
        c: x.searchCountryClicked,
        g: x.searchGateClicked,
        u: x.renderedUrl?.replace(BASE, ''),
      })),
    )}`,
  );
}

async function main(): Promise<void> {
  // ---- Fixture A: country-picker modal portal ----
  const a = await runCase('MockFoundever', `${BASE}/index.html`);
  const aLeads = a.leads ?? [];
  summarize('A', a);
  check('A: US role "Remote Customer Service Representative" found at 70', aLeads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), aLeads);
  check('A: US role "Bilingual Customer Service Associate 1" found at 60', aLeads.some((l) => l.title === 'Bilingual Customer Service Associate 1' && l.matchScore === 60), aLeads);
  // The Retention role is Virginia, US — on-site, not remote — so
  // the remote-only sweep rejects it on location (round 15 counted
  // it as a 4th lead only because the location span was unread and
  // the role read as blank-location).
  check('A: exactly 3 leads (Retention is Virginia on-site, location-rejected)', aLeads.length === 3, aLeads);
  check('A: Retention role location-rejected with its real location read', (a.screened?.rejected ?? []).some((r) => r.title === 'Retention Customer Service Associate' && r.location === 'Virginia, US' && r.reason === 'location'), a.screened?.rejected);
  check('A: no Budapest/Moravia lead (no clobber to the global page)', !aLeads.some((l) => /Budapest|Moravia|Polish/i.test(l.title)), aLeads);
  check('A: landed on the US results page with no submit query', typeof a.renderedUrl === 'string' && a.renderedUrl.includes('results-us.html') && !a.renderedUrl.includes('?'), a.renderedUrl);
  check('A: search outcome is searched', a.searchOutcome === 'searched', a.searchOutcome);
  check('A: country pick reported as "United States (USA)"', (a.renderAttempts ?? []).some((x) => x.searchCountryClicked === 'United States (USA)'), a.renderAttempts);
  check('A: gate log shows only the US pick (no Work-from-Home pick after navigation)', (a.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States (USA)') && !(a.renderAttempts ?? []).some((x) => x.searchGateClicked === 'Work from Home'), a.renderAttempts);

  // ---- Fixture B: native <select> region dropdown ----
  const b = await runCase('MockRegion', `${BASE}/select.html`);
  const bLeads = b.leads ?? [];
  summarize('B', b);
  check('B: US role found via the <select> pick', bLeads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore >= 60), bLeads);
  check('B: search outcome is searched', b.searchOutcome === 'searched', b.searchOutcome);
  check('B: gate log shows the "United States" select pick', (b.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States'), b.renderAttempts);

  // ---- Fixture C: TTEC / TalentBrew (plain HTML, Strategy D) ----
  // The Las Vegas role is ON-SITE, so the remote-only sweep rejects
  // it on location: TTEC yields 0 leads, and the extraction is what
  // the case proves (all 8 cards, no false "Next" posting).
  const c = await runCase('MockTTEC', `${BASE}/ttec.html`);
  const cLeads = c.leads ?? [];
  summarize('C', c);
  check('C: 8 postings seen (page 1 of 38)', c.postingsSeen === 8, c.postingsSeen);
  check('C: 0 leads (Las Vegas role is on-site, Athens/Krakow/Mohali non-US)', cLeads.length === 0, cLeads);
  check('C: Las Vegas Customer Service Representative was extracted (location reject, not a miss)', (c.screened?.rejected ?? []).some((r) => r.title === 'Customer Service Representative' && r.location === 'Las Vegas, Nevada' && r.reason === 'location'), c.screened?.rejected);
  check('C: 6 location rejects (Las Vegas + Athens x2 + Krakow + Santa Rosa + Mohali)', c.screened?.rejectedLocation === 6, c.screened);
  check('C: 2 no-match (non-English titles)', c.screened?.rejectedNoMatch === 2, c.screened);
  check('C: no render used (plain HTML had the cards)', c.renderUsed === false, c.renderUsed);

  // ---- Fixture D: Alorica (search submit -> real results) ----
  const d = await runCase('MockAlorica', `${BASE}/alorica.html`);
  const dLeads = d.leads ?? [];
  summarize('D', d);
  check('D: search outcome is searched', d.searchOutcome === 'searched', d.searchOutcome);
  check('D: 4 postings seen', d.postingsSeen === 4, d.postingsSeen);
  check('D: Customer Service Representative lead at 65', dLeads.some((l) => l.title === 'Customer Service Representative' && l.matchScore === 65), dLeads);
  check('D: Bilingual Customer Service Representative lead at 65', dLeads.some((l) => l.title === 'Bilingual Customer Service Representative' && l.matchScore === 65), dLeads);
  check('D: Customer Support Specialist lead at 65', dLeads.some((l) => l.title === 'Customer Support Specialist' && l.matchScore === 65), dLeads);
  check('D: exactly 3 leads (Warehouse Associate is no-match)', dLeads.length === 3, dLeads);
  check('D: render was used', d.renderUsed === true, d.renderUsed);

  // ---- Fixture D0: Alorica zero-results variant ----
  const d0 = await runCase('MockAloricaZero', `${BASE}/alorica-zero.html`);
  summarize('D0', d0);
  check('D0: search outcome is no-results', d0.searchOutcome === 'no-results', d0.searchOutcome);
  check('D0: 0 postings, 0 leads', d0.postingsSeen === 0 && (d0.leads ?? []).length === 0, { postings: d0.postingsSeen, leads: d0.leads });

  // ---- Fixture E: Sitel (landing page -> Foundever-shape portal) ----
  const e = await runCase('MockSitel', `${BASE}/sitel.html`);
  const eLeads = e.leads ?? [];
  summarize('E', e);
  check('E: search outcome is searched', e.searchOutcome === 'searched', e.searchOutcome);
  check('E: landed on the US results page', typeof e.renderedUrl === 'string' && e.renderedUrl.includes('results-us.html'), e.renderedUrl);
  check('E: 3 US leads (same set as fixture A; Retention is Virginia on-site)', eLeads.length === 3 && eLeads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), eLeads);
  check('E: one render only (the gate opener navigated to the portal and the loop drove it there)', (e.renderAttempts ?? []).length === 1, e.renderAttempts);
  check('E: country pick reported as "United States (USA)"', (e.renderAttempts ?? []).some((x) => x.searchCountryClicked === 'United States (USA)'), e.renderAttempts);

  // ---- Fixture F1: Omni custom-dropdown gate behind a site search ----
  const f1 = await runCase('MockOmni', `${BASE}/omni.html`);
  const f1Leads = f1.leads ?? [];
  summarize('F1', f1);
  check('F1: search outcome is searched', f1.searchOutcome === 'searched', f1.searchOutcome);
  check('F1: landed on the US results page', typeof f1.renderedUrl === 'string' && f1.renderedUrl.includes('omni-us.html'), f1.renderedUrl);
  check('F1: 3 US leads (Retention is Virginia on-site)', f1Leads.length === 3 && f1Leads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), f1Leads);
  // The attempt record keeps only the LAST gate label, so the opener
  // ("Select your country") is overwritten by the US pick — the pick
  // itself proves the opener fired, because the menu options are
  // hidden until it does.
  check('F1: gate log shows the US pick (the opener fired first: the option is hidden until it does)', (f1.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States' && x.searchCountryClicked === 'United States'), f1.renderAttempts);

  // ---- Fixture F2: Omni bare country links (no dropdown container) ----
  const f2 = await runCase('MockOmniLinks', `${BASE}/omni-links.html`);
  const f2Leads = f2.leads ?? [];
  summarize('F2', f2);
  check('F2: search outcome is searched', f2.searchOutcome === 'searched', f2.searchOutcome);
  check('F2: landed on the US results page', typeof f2.renderedUrl === 'string' && f2.renderedUrl.includes('omni-us.html'), f2.renderedUrl);
  check('F2: 3 US leads (Retention is Virginia on-site)', f2Leads.length === 3 && f2Leads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), f2Leads);
  check('F2: gate log shows the bare "United States" link pick', (f2.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States'), f2.renderAttempts);

  // ---- Fixture G: Teleperformance (teaser -> portal dropdown, inline results) ----
  // The entry page is a homepage, not a careers page: careersUrl is
  // empty, so the featured role counts as a teaser and the walk
  // continues to the portal.
  const g = await runCase('MockTP', `${BASE}/tp.html`, '');
  const gLeads = g.leads ?? [];
  summarize('G', g);
  check('G: search outcome is searched', g.searchOutcome === 'searched', g.searchOutcome);
  check('G: 4 postings seen (portal list, not the homepage teaser)', g.postingsSeen === 4, g.postingsSeen);
  check('G: 3 US leads', gLeads.length === 3, gLeads);
  check('G: Technical Support Representative lead at 65', gLeads.some((l) => l.title === 'Technical Support Representative' && l.matchScore === 65), gLeads);
  check('G: 1 location reject (Kingston, Jamaica role)', g.screened?.rejectedLocation === 1, g.screened);
  check('G: source page is the portal (tp-jobs.html), not the teaser homepage', typeof g.sourcePage === 'string' && g.sourcePage.includes('tp-jobs.html'), g.sourcePage);

  // ---- Fixture H: Kelly (JS-injected non-CS roles — 0 leads is correct) ----
  const h = await runCase('MockKelly', `${BASE}/kelly.html`);
  summarize('H', h);
  check('H: 4 postings seen (JS-injected cards surfaced by the render)', h.postingsSeen === 4, h.postingsSeen);
  check('H: 0 leads is correct (Assembler/Forklift/Nurse/Accountant are not CS)', (h.leads ?? []).length === 0, h.leads);
  check('H: render was used', h.renderUsed === true, h.renderUsed);

  // ---- Fixture I: NexRep (board-linked non-CS roles — 0 leads is correct) ----
  const i = await runCase('MockNexRep', `${BASE}/nexrep.html`);
  summarize('I', i);
  check('I: 4 postings seen (Paylocity-style board reached from the walk)', i.postingsSeen === 4, i.postingsSeen);
  check('I: 0 leads is correct (Quality/Resource/Real Time/Payroll are not CS)', (i.leads ?? []).length === 0, i.leads);

  // ---- Fixture J: Working Solutions (non-CS roles — 0 leads is correct) ----
  const j = await runCase('MockWS', `${BASE}/ws.html`);
  summarize('J', j);
  check('J: 3 postings seen', j.postingsSeen === 3, j.postingsSeen);
  check('J: 0 leads is correct (Data Entry/Warehouse/Marketing are not CS)', (j.leads ?? []).length === 0, j.leads);

  // eslint-disable-next-line no-console
  console.log(failures === 0 ? 'LOCAL-RENDER-ALL-PASS' : `LOCAL-RENDER-${failures}-FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('DRIVER-ERROR', e);
  process.exit(2);
});
