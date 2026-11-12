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
 *   S. results-us-slug.html — the Sitel US-results page, but the
 *      Retention card carries NO location span: its location lives
 *      only in its Phenom slug (Wise, VA). The reader must read it
 *      from the slug and reject the role, while the 3 remote leads
 *      still pass (round 17, 2026-11-12 canary).
 *   L. slow-portal.html — slow-settle gate page: a cookie banner
 *      injected late (~3s) + a ticker that keeps growing for ~12s,
 *      so load + settle eat the nominal 8s budget before the search
 *      gate runs (the live Foundever skipped-time shape). The
 *      search-minimum guarantee must still run the search.
 *   D1. alorica-gated.html — bling-ai shell whose form submits to a
 *      zero-results page until the "United States" filter is picked;
 *      the search step must re-submit AFTER the gate.
 *   K. omni-corporate-careers.html — corporate careers page with
 *      only the header site search + nav links ("Meet Our Leadership
 *      Team", "Join Our Talent Network"); the gate resolver must NOT
 *      click leadership as an opener, and the render must reach the
 *      join portal (careersUrl) instead.
 *   I2. nexrep-js.html — marketing careers page linking to the
 *      Paylocity-shaped JS shell; the render must target the
 *      /recruiting/jobs/All/ list URL first (0 leads is correct).
 *   T. tp-flaky.html — a stub renderer that dies fast twice on the
 *      entry target, then serves the US results on the next target:
 *      fast deaths must be free, the same-target retry must fire,
 *      and the loop must reach the later target inside a max-2
 *      budget (Teleperformance's RST shape).
 *   F3. omni-blog.html — Omni homepage with no search box, per-country
 *      "Find a Contract" links, and a blog article link whose title
 *      matches the opener words ("What Does 'Choose Your Schedule'
 *      Mean at Omni?"). The live gate clicked that title as an
 *      opener and navigated onto the article; /join/ never rendered.
 *      The guard must never pick it: the homepage ends no-form and
 *      the loop retries the join portal.
 *   F4. ws-faq.html — Working Solutions jobs homepage with an FAQ
 *      accordion whose 15-word question matches the opener word
 *      "country", ahead of the real country dropdown in the DOM. The
 *      live gate clicked the FAQ question; the guard must skip all
 *      three FAQ questions (question-word starts + word caps) and
 *      drive the country dropdown instead. The FAQ click is an
 *      accordion toggle (no navigation, like live), so the driver
 *      case proves the end state; the suite test is the
 *      before/after on the opener itself.
 *   I3. nexrep-tail.html — NexRep careers page with a "Work from
 *      Home" link (in a dropdown-menu container) to a register page,
 *      plus the Paylocity list. After the Paylocity list renders
 *      'has-listings' with its roles surfaced, the loop must NOT
 *      spend its second render on this page — the live tail drifted
 *      to the register form and the outcome read 'no-form' with the
 *      register URL.
 *   P. probe mode — calls the test-company handler with probe:true
 *      against tp-jobs.html and checks the markup outline end to
 *      end (the 4 job anchors, the extractor's parsed count, the
 *      results-count line).
 *
 * Run: esbuild local-verify/driver.ts --bundle --platform=node
 *        --format=cjs --external:mongodb --outfile=/tmp/local-driver.cjs
 *      then: python3 -m http.server 8811 --bind 127.0.0.1
 *        --directory local-verify/fixtures  (background)
 *      then: node /tmp/local-driver.cjs
 */

import { readFileSync } from 'node:fs';
import { searchCompanyJobs, portalSearchTerm } from '../api/find-jobs.js';
import { renderPageHtml, type RenderPageResult } from '../api/render-page.js';
import testCompanyHandler from '../api/test-company.js';

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
  // Round 18: the 4th Paylocity item is "Share Your Information", a
  // talent-pool signup link (live 2026-11-12 canary) — junk, not a
  // role — so 3 postings is the correct count, not 4.
  const i = await runCase('MockNexRep', `${BASE}/nexrep.html`);
  summarize('I', i);
  check('I: 3 postings seen (Paylocity-style board reached from the walk; Share Your Information is junk)', i.postingsSeen === 3, i.postingsSeen);
  check('I: 0 leads is correct (Quality/Resource/Real Time are not CS)', (i.leads ?? []).length === 0, i.leads);
  check('I: "Share Your Information" never surfaces as a posting', !(i.screened?.rejected ?? []).some((r) => r.title === 'Share Your Information'), i.screened?.rejected);

  // ---- Fixture J: Working Solutions (non-CS roles — 0 leads is correct) ----
  const j = await runCase('MockWS', `${BASE}/ws.html`);
  summarize('J', j);
  check('J: 3 postings seen', j.postingsSeen === 3, j.postingsSeen);
  check('J: 0 leads is correct (Data Entry/Warehouse/Marketing are not CS)', (j.leads ?? []).length === 0, j.leads);

  // ---- Fixture S: Sitel slug-only Retention card ----
  // The US-results page where the Retention card has NO location
  // span: its location lives only in its Phenom slug. Plain-HTML
  // walk must read 'Wise, VA' from the slug and reject it — the
  // live canary read it blank and counted a 4th lead.
  const s = await runCase('MockSitelSlug', `${BASE}/results-us-slug.html`);
  const sLeads = s.leads ?? [];
  summarize('S', s);
  check('S: exactly 3 leads (Retention rejected from its slug)', sLeads.length === 3, sLeads);
  check('S: Retention location-rejected with the slug-read location Wise, VA', (s.screened?.rejected ?? []).some((r) => r.title === 'Retention Customer Service Associate' && r.location === 'Wise, VA' && r.reason === 'location'), s.screened?.rejected);
  check('S: no render used (plain HTML had the cards)', s.renderUsed === false, s.renderUsed);

  // ---- Fixture L: Foundever slow-settle gate page ----
  // Direct renderPageHtml with a nominal 8s timeout: the load +
  // settles eat it before the search gate runs, so without the
  // search-minimum guarantee this ends skipped-time. With it, the
  // search gets its own window past the timeout and lands on the
  // US results page.
  const lStart = Date.now();
  const l = await renderPageHtml(`${BASE}/slow-portal.html`, portalSearchTerm(RESUME), 8000);
  const lElapsed = Date.now() - lStart;
  const lHtml = l?.html ?? '';
  // eslint-disable-next-line no-console
  console.log(`L render: outcome=${l?.searchOutcome} renderedUrl=${l?.renderedUrl} elapsedMs=${lElapsed}`);
  check('L: search outcome is searched (not skipped-time)', l?.searchOutcome === 'searched', l?.searchOutcome);
  check('L: landed on the slow US results page', typeof l?.renderedUrl === 'string' && l.renderedUrl.includes('slow-results.html'), l?.renderedUrl);
  check('L: results page carries the Remote CSR role', lHtml.includes('Remote Customer Service Representative'), lHtml.slice(0, 200));
  check('L: elapsed time exceeds the nominal 8s timeout (the search ran past it)', lElapsed > 8000, lElapsed);

  // ---- Fixture D1: Alorica gated search (re-submit after the gate) ----
  const d1 = await runCase('MockAloricaGated', `${BASE}/alorica-gated.html`);
  const d1Leads = d1.leads ?? [];
  summarize('D1', d1);
  check('D1: search outcome is searched (the gate pick did not strand the search at 0 roles)', d1.searchOutcome === 'searched', d1.searchOutcome);
  check('D1: 4 postings seen', d1.postingsSeen === 4, d1.postingsSeen);
  check('D1: Customer Service Representative lead at 65', d1Leads.some((l) => l.title === 'Customer Service Representative' && l.matchScore === 65), d1Leads);
  check('D1: Bilingual Customer Service Representative lead at 65', d1Leads.some((l) => l.title === 'Bilingual Customer Service Representative' && l.matchScore === 65), d1Leads);
  check('D1: Customer Support Specialist lead at 65', d1Leads.some((l) => l.title === 'Customer Support Specialist' && l.matchScore === 65), d1Leads);
  check('D1: exactly 3 leads (Warehouse Associate is no-match)', d1Leads.length === 3, d1Leads);
  check('D1: gate log shows the "United States" pick (the re-submit ran after it)', (d1.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States'), d1.renderAttempts);

  // ---- Fixture K: Omni corporate careers page (no wrong gate pick) ----
  const k = await runCase('MockOmniCorp', `${BASE}/omni-corporate-careers.html`, `${BASE}/omni-join.html`);
  const kLeads = k.leads ?? [];
  summarize('K', k);
  check('K: search outcome is searched', k.searchOutcome === 'searched', k.searchOutcome);
  check('K: landed on the search results page (via the join portal)', typeof k.renderedUrl === 'string' && k.renderedUrl.includes('omni-search.html'), k.renderedUrl);
  check('K: 3 US leads (Retention is Virginia on-site)', kLeads.length === 3 && kLeads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), kLeads);
  check('K: gate log never shows "Meet Our Leadership Team" (nav links are not openers)', !(k.renderAttempts ?? []).some((x) => x.searchGateClicked === 'Meet Our Leadership Team'), k.renderAttempts);

  // ---- Fixture I2: NexRep JS portal (Paylocity-shaped list URL) ----
  const i2 = await runCase('MockNexRepJS', `${BASE}/nexrep-js.html`);
  summarize('I2', i2);
  check('I2: 3 postings seen (JS shell surfaced by the render; Share Your Information is junk)', i2.postingsSeen === 3, i2.postingsSeen);
  check('I2: 0 leads is correct (Quality/Resource/Real Time are not CS)', (i2.leads ?? []).length === 0, i2.leads);
  check('I2: the Paylocity-shaped list URL is the first render target', (i2.renderTargets ?? [])[0]?.url.includes('/recruiting/jobs/All/') === true, i2.renderTargets);
  check('I2: source page is the Paylocity-shaped list URL', typeof i2.sourcePage === 'string' && i2.sourcePage.includes('/recruiting/jobs/All/'), i2.sourcePage);
  check('I2: render was used', i2.renderUsed === true, i2.renderUsed);
  // Round 18 tail: the Paylocity list reported 'has-listings' with its
  // roles surfaced, so the loop must NOT spend its second render on
  // the careers page — the outcome stays 'has-listings' on the
  // Paylocity URL (live: 'no-form' with the register URL).
  check('I2: search outcome is has-listings (the list page, not the tail)', i2.searchOutcome === 'has-listings', i2.searchOutcome);
  check('I2: rendered URL stays on the Paylocity list (no drift to the careers page)', typeof i2.renderedUrl === 'string' && i2.renderedUrl.includes('/recruiting/jobs/All/'), i2.renderedUrl);
  check('I2: exactly one render attempt (the second render is not spent)', (i2.renderAttempts ?? []).length === 1, i2.renderAttempts);

  // ---- Fixture T: Teleperformance flaky render (fast deaths are free) ----
  // A stub renderer that dies fast twice on the entry target, then
  // serves the US results on the next target: the loop must retry
  // the same target once for free and still reach the later target
  // inside a max-2 budget.
  const resultsUsHtml = readFileSync(
    '/home/hatch/workspace/jobboard/local-verify/fixtures/results-us.html',
    'utf-8',
  );
  let tCalls = 0;
  const tTargets: string[] = [];
  const stubFlaky = async (url: string, _searchTerm: string): Promise<RenderPageResult | null> => {
    tCalls += 1;
    tTargets.push(url);
    if (tCalls <= 2) {
      return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: '', renderError: 'render-failed' };
    }
    return { html: resultsUsHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url };
  };
  const t = (await searchCompanyJobs(
    { name: 'MockTPFlaky', website: `${BASE}/tp-flaky.html`, careersUrl: '' },
    RESUME,
    { renderPage: stubFlaky, renderBudget: { used: 0, max: 2 } },
  )) as unknown as CaseResult;
  const tLeads = t.leads ?? [];
  summarize('T', t);
  check('T: exactly 3 render calls (2 free fast deaths + 1 charged success)', tCalls === 3, { calls: tCalls, targets: tTargets });
  check('T: first two calls hit the same target (the free same-target retry)', tTargets[0] === tTargets[1] && tTargets[0] === `${BASE}/tp-flaky.html`, tTargets);
  check('T: third call reached the next target (tp-flaky-b.html)', (tTargets[2] ?? '').includes('tp-flaky-b.html'), tTargets);
  check('T: 3 leads from the served results', tLeads.length === 3, tLeads);

  // ---- Fixture F3: Omni blog-title gate (round 18) ----
  // Homepage with no search box: the search step finds no form, so the
  // gate loop is where the live render clicked the blog article title
  // as an opener and navigated onto the article. The guard must never
  // pick it: the homepage ends no-form and the loop retries the join
  // portal instead.
  const f3 = await runCase('MockOmniBlog', `${BASE}/omni-blog.html`);
  const f3Leads = f3.leads ?? [];
  summarize('F3', f3);
  check('F3: search outcome is searched (via the join portal)', f3.searchOutcome === 'searched', f3.searchOutcome);
  check('F3: landed on the join portal search results', typeof f3.renderedUrl === 'string' && f3.renderedUrl.includes('omni-search.html'), f3.renderedUrl);
  check('F3: 3 US leads (Retention is Virginia on-site)', f3Leads.length === 3 && f3Leads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), f3Leads);
  check('F3: gate log never shows the blog article title', !(f3.renderAttempts ?? []).some((x) => (x.searchGateClicked ?? '').includes('Choose Your Schedule')), f3.renderAttempts);
  check('F3: the homepage rendered first (it outranks /join/ on content)', (f3.renderAttempts ?? [])[0]?.target?.includes('omni-blog.html') === true, f3.renderAttempts);
  check('F3: the first attempt ended no-form (no blog detour)', (f3.renderAttempts ?? [])[0]?.outcome === 'no-form', f3.renderAttempts);
  check('F3: exactly two render attempts (homepage no-form, then join)', (f3.renderAttempts ?? []).length === 2, f3.renderAttempts);

  // ---- Fixture F4: Working Solutions FAQ gate (round 18) ----
  // Jobs homepage with an FAQ accordion whose 15-word question matches
  // the opener word "country", ahead of the real country dropdown in
  // the DOM. The live gate clicked the FAQ question; the guard must
  // skip all three FAQ questions (question-word starts + word caps)
  // and drive the country dropdown instead. The FAQ click is an
  // accordion toggle (no navigation, like live), so the suite test is
  // the before/after on the opener itself — this case proves the end
  // state: the US list, 3 leads, gate log ending on the US pick.
  const f4 = await runCase('MockWSFaq', `${BASE}/ws-faq.html`);
  const f4Leads = f4.leads ?? [];
  summarize('F4', f4);
  check('F4: search outcome is searched', f4.searchOutcome === 'searched', f4.searchOutcome);
  check('F4: landed on the US results page', typeof f4.renderedUrl === 'string' && f4.renderedUrl.includes('ws-faq-us.html'), f4.renderedUrl);
  check('F4: 3 US leads', f4Leads.length === 3 && f4Leads.some((l) => l.title === 'Remote Customer Service Representative' && l.matchScore === 70), f4Leads);
  check('F4: gate log never shows any FAQ question', !(f4.renderAttempts ?? []).some((x) => /CAN I APPLY|HOW DO I APPLY|WHAT IS WORKING/i.test(x.searchGateClicked ?? '')), f4.renderAttempts);
  check('F4: gate log shows the "United States" pick', (f4.renderAttempts ?? []).some((x) => x.searchGateClicked === 'United States'), f4.renderAttempts);

  // ---- Fixture I3: NexRep register drift (round 18) ----
  // Careers page with a "Work from Home" link to a register page, plus
  // the Paylocity list. After the list renders 'has-listings' with its
  // roles surfaced, the loop must NOT spend its second render here —
  // the live tail drifted to the register form and the outcome read
  // 'no-form' with the register URL.
  const i3 = await runCase('MockNexRepTail', `${BASE}/nexrep-tail.html`);
  summarize('I3', i3);
  check('I3: 3 postings seen (Paylocity list; Share Your Information is junk)', i3.postingsSeen === 3, i3.postingsSeen);
  check('I3: 0 leads is correct (Quality/Resource/Real Time are not CS)', (i3.leads ?? []).length === 0, i3.leads);
  check('I3: search outcome is has-listings (the list page, not the tail)', i3.searchOutcome === 'has-listings', i3.searchOutcome);
  check('I3: rendered URL stays on the Paylocity list (no register drift)', typeof i3.renderedUrl === 'string' && i3.renderedUrl.includes('/recruiting/jobs/All/'), i3.renderedUrl);
  check('I3: exactly one render attempt (the careers page is never rendered)', (i3.renderAttempts ?? []).length === 1, i3.renderAttempts);
  check('I3: gate log never shows "Work from Home"', !(i3.renderAttempts ?? []).some((x) => x.searchGateClicked === 'Work from Home'), i3.renderAttempts);

  // ---- Fixture P: probe mode end-to-end (round 18) ----
  // The test-company probe renders tp-jobs.html directly and returns
  // the markup outline: the 4 job anchors must show up, with the
  // extractor's own parsed count agreeing.
  process.env.SYNC_KEY = 'test-key';
  const probeReq = {
    method: 'POST',
    headers: { 'x-sync-key': 'test-key' },
    body: {
      company: { name: 'MockTPProbe', website: `${BASE}/tp-jobs.html`, careersUrl: `${BASE}/tp-jobs.html` },
      resumeText: RESUME,
      probe: true,
    },
  } as unknown as Parameters<typeof testCompanyHandler>[0];
  let probeStatus = 0;
  let probeBody: {
    probe?: boolean;
    searchOutcome?: string | null;
    markup?: { anchors?: { text: string }[]; parsedPostings?: number; countLines?: string[] } | null;
  } | null = null;
  const probeRes = {
    status: (c: number) => {
      probeStatus = c;
      return probeRes;
    },
    json: (o: NonNullable<typeof probeBody>) => {
      probeBody = o;
      return probeRes;
    },
  } as unknown as Parameters<typeof testCompanyHandler>[1];
  await testCompanyHandler(probeReq, probeRes);
  const pMarkup = probeBody?.markup ?? null;
  // eslint-disable-next-line no-console
  console.log(
    `P probe: status=${probeStatus} outcome=${probeBody?.searchOutcome} anchors=${JSON.stringify(pMarkup?.anchors?.map((a) => a.text))} parsed=${pMarkup?.parsedPostings} countLines=${JSON.stringify(pMarkup?.countLines)}`,
  );
  check('P: probe answers 200 with probe:true', probeStatus === 200 && probeBody?.probe === true, { probeStatus, probeBody });
  check('P: probe search outcome is searched (the US pick ran)', probeBody?.searchOutcome === 'searched', probeBody?.searchOutcome);
  check(
    'P: probe outline lists the 4 TP job anchors',
    (pMarkup?.anchors ?? []).length === 4 && (pMarkup?.anchors ?? []).some((a) => a.text === 'Customer Service Representative'),
    pMarkup?.anchors,
  );
  check('P: probe outline parsed count agrees with the extractor (4)', pMarkup?.parsedPostings === 4, pMarkup?.parsedPostings);
  check('P: probe outline carries the results-count line', (pMarkup?.countLines ?? []).some((l) => /of 4/.test(l)), pMarkup?.countLines);

  // eslint-disable-next-line no-console
  console.log(failures === 0 ? 'LOCAL-RENDER-ALL-PASS' : `LOCAL-RENDER-${failures}-FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('DRIVER-ERROR', e);
  process.exit(2);
});
