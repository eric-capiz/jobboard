#!/usr/bin/env node
/* Fixture canary for the finder-runner image — the 14-employer canary
 * logic run against the LOCAL runner server, using ONLY the
 * local-verify fixtures. No live employer site is ever fetched, the
 * live Vercel app is never called, and nothing writes to the board:
 * every case POSTs to the runner's /api/test-company (read-only by
 * design) with autoAdd nowhere in the path.
 *
 * What it proves: the runner image's code path end to end — the
 * bundled server (cloud-run/runner/dist-server/server.mjs), plain-HTML
 * extraction (Strategies A–F), the real Chromium render + portal
 * search gate + Strategy C extraction, the CS gate, and the location
 * rules — against mock pages that mirror the live portal shapes.
 *
 * How it runs:
 *   1. Serves local-verify/fixtures/ on 127.0.0.1:8811 (in-process
 *      node:http static server — no python dependency).
 *   2. Spawns the runner server bundle on 127.0.0.1:8081 with a
 *      throwaway SYNC_KEY (local-canary-test-key). TMPDIR points at
 *      the repo's .chromium-tmp when it exists, so the already
 *      extracted Chromium pack is reused instead of re-downloading.
 *   3. POSTs one /api/test-company per fixture case and asserts the
 *      expected outcome. Kills both servers and exits 0 iff every
 *      runnable case passes.
 *
 * EXPECTATIONS — READ BEFORE THE FORMAL RUN: the assertions below are
 * the local-verify/driver.ts (round-18/20) expectations. Round 21
 * fixes 6 systemic bugs (test-company isUSCompany; extractor
 * accepting job-board apply links; title-embedded locations; the
 * "on-call" CS-gate token; category/blog pages as postings; gate
 * holes for housekeeping/energy/teaching roles) and CAN change
 * fixture outcomes — e.g. a case whose leads previously passed on a
 * blank location, or a posting previously extracted from a board
 * apply link. The FORMAL canary must run against the post-round-21
 * head, and its expectations must be re-checked against round 21's
 * own updated driver.ts / FakePage counts first. A failure on a case
 * that round 21 deliberately changed is an EXPECTATION update, not
 * a runner regression — judge it against the round-21 evidence, not
 * against this file's pre-round-21 numbers. Do NOT run the formal
 * canary from the 47fea165 head.
 *
 * COVERAGE: 9 of the 14 canary employers have fixtures (Foundever,
 * Sitel, Teleperformance, TTEC, Alorica, NexRep, Working Solutions,
 * Omni, Kelly). 5 have NO fixture and are reported NO-FIXTURE (skip,
 * not fail): Concentrix, Sutherland, Day Kimball, NSSF, AIR. Those
 * 5 can only be proven by the LIVE canary on the deployed host —
 * which still awaits deployment and cannot run from this VM.
 *
 * ENV:
 *   RUNNER_PORT   runner server port (default 8081)
 *   FIXTURE_PORT  fixture server port (default 8811)
 *   SYNC_KEY      throwaway key for the local runner
 *                 (default local-canary-test-key)
 *   RESUME_PATH   resume text (default
 *                 sweep-2026-11-11-cs-v4/resume.txt — the same file
 *                 local-verify/driver.ts uses, so scores compare)
 *   TMPDIR        Chromium extraction dir (default: the repo's
 *                 .chromium-tmp when present, else the OS tmpdir)
 *
 * EXIT CODES: 0 = all runnable cases pass; 1 = any case fails or a
 * server fails to start. NO-FIXTURE employers never fail the run.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const RUNNER_PORT = Number(process.env.RUNNER_PORT ?? 8081);
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 8811);
const SYNC_KEY = process.env.SYNC_KEY ?? 'local-canary-test-key';
const RESUME_PATH =
  process.env.RESUME_PATH ?? path.join(ROOT, 'sweep-2026-11-11-cs-v4', 'resume.txt');
const FIXTURES_DIR = path.join(ROOT, 'local-verify', 'fixtures');
const BUNDLE = path.join(__dirname, 'dist-server', 'server.mjs');

const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const RUNNER = `http://127.0.0.1:${RUNNER_PORT}`;

const RESUME = await readFile(RESUME_PATH, 'utf-8');

let failures = 0;
let passes = 0;
const skipped = [];

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  if (ok) passes += 1;
  else failures += 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Fixture static server (in-process; fixtures only)                   */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function fixtureServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const filePath = path.normalize(path.join(FIXTURES_DIR, pathname));
      if (!filePath.startsWith(FIXTURES_DIR)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Runner server (child process)                                       */
/* ------------------------------------------------------------------ */

let runnerProc = null;

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(1000);
  }
  return false;
}

async function startRunner() {
  if (!existsSync(BUNDLE)) {
    throw new Error(`runner server bundle not found: ${BUNDLE} (run cloud-run/runner/build.sh)`);
  }
  const tmpdir = process.env.TMPDIR ?? (existsSync(path.join(ROOT, '.chromium-tmp')) ? path.join(ROOT, '.chromium-tmp') : undefined);
  log(`starting runner server: node ${BUNDLE} (port ${RUNNER_PORT}, TMPDIR=${tmpdir ?? '(default)'})`);
  runnerProc = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, PORT: String(RUNNER_PORT), SYNC_KEY, ...(tmpdir ? { TMPDIR: tmpdir } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runnerProc.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) log(`[runner] ${line.trim()}`);
  });
  runnerProc.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) log(`[runner:err] ${line.trim()}`);
  });
  if (!(await waitForHealth(RUNNER, 90000))) {
    throw new Error(`runner server never became healthy at ${RUNNER}/healthz`);
  }
  log(`runner server healthy at ${RUNNER}`);
}

async function stopRunner() {
  if (!runnerProc) return;
  const proc = runnerProc;
  runnerProc = null;
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => proc.on('exit', resolve)),
      sleep(10000).then(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }),
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

async function testCompany(name, website, careersUrl) {
  const r = await fetch(`${RUNNER}/api/test-company`, {
    method: 'POST',
    headers: { 'x-sync-key': SYNC_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      company: { name, website, careersUrl: careersUrl ?? website },
      resumeText: RESUME,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`test-company HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function leadTitles(result) {
  return (result.leads ?? []).map((l) => `${l.title} (${l.matchScore})`);
}

function summarize(label, r) {
  log(
    `${label} leads: ${JSON.stringify(leadTitles(r))} | postings: ${r.postingsSeen} | outcome: ${r.searchOutcome} | renderedUrl: ${(r.renderedUrl ?? '').replace(BASE, '')} | source: ${(r.sourcePage ?? '').replace(BASE, '')} | renderUsed: ${r.renderUsed}`,
  );
}

const hasLead = (r, title, score) =>
  (r.leads ?? []).some((l) => l.title === title && (score === undefined || l.matchScore === score));
const rejected = (r, title, location, reason) =>
  (r.screened?.rejected ?? []).some(
    (x) => x.title === title && (location === undefined || x.location === location) && (reason === undefined || x.reason === reason),
  );
const gateShows = (r, needle) =>
  (r.renderAttempts ?? []).some((a) => (a.searchGateClicked ?? '').includes(needle));
const gateHides = (r, needle) =>
  !(r.renderAttempts ?? []).some((a) => (a.searchGateClicked ?? '').includes(needle));

async function main() {
  const fixtureHttp = fixtureServer();
  await new Promise((resolve) => fixtureHttp.listen(FIXTURE_PORT, '127.0.0.1', resolve));
  log(`fixture server on ${BASE} (dir: ${FIXTURES_DIR})`);
  try {
    await startRunner();

    // --- Foundever (fixture A: country-picker modal portal) ---
    {
      const r = await testCompany('MockFoundever', `${BASE}/index.html`);
      summarize('A Foundever', r);
      check('A: Remote Customer Service Representative at 70', hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('A: Bilingual Customer Service Associate 1 at 60', hasLead(r, 'Bilingual Customer Service Associate 1', 60), leadTitles(r));
      check('A: exactly 3 leads (Retention is Virginia on-site)', (r.leads ?? []).length === 3, leadTitles(r));
      check('A: Retention location-rejected as Virginia, US', rejected(r, 'Retention Customer Service Associate', 'Virginia, US', 'location'), r.screened?.rejected);
      check('A: no Budapest/Moravia lead (no clobber to global page)', !(r.leads ?? []).some((l) => /Budapest|Moravia|Polish/i.test(l.title)), leadTitles(r));
      check('A: landed on US results page, no submit query', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('results-us.html') && !r.renderedUrl.includes('?'), r.renderedUrl);
      check('A: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('A: country pick reported as "United States (USA)"', (r.renderAttempts ?? []).some((a) => a.searchCountryClicked === 'United States (USA)'), r.renderAttempts);
    }

    // --- Sitel (fixture E: landing page -> Foundever-shape portal) ---
    {
      const r = await testCompany('MockSitel', `${BASE}/sitel.html`);
      summarize('E Sitel', r);
      check('E: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('E: landed on the US results page', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('results-us.html'), r.renderedUrl);
      check('E: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('E: one render only', (r.renderAttempts ?? []).length === 1, r.renderAttempts);
    }

    // --- Sitel slug-only Retention card (fixture S) ---
    {
      const r = await testCompany('MockSitelSlug', `${BASE}/results-us-slug.html`);
      summarize('S SitelSlug', r);
      check('S: exactly 3 leads (Retention rejected from its slug)', (r.leads ?? []).length === 3, leadTitles(r));
      check('S: Retention location-rejected with slug-read Wise, VA', rejected(r, 'Retention Customer Service Associate', 'Wise, VA', 'location'), r.screened?.rejected);
      check('S: no render used (plain HTML had the cards)', r.renderUsed === false, r.renderUsed);
    }

    // --- Teleperformance (fixture G: teaser -> portal dropdown) ---
    {
      const r = await testCompany('MockTP', `${BASE}/tp.html`, '');
      summarize('G Teleperformance', r);
      check('G: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('G: 4 postings seen (portal list, not homepage teaser)', r.postingsSeen === 4, r.postingsSeen);
      check('G: 3 US leads', (r.leads ?? []).length === 3, leadTitles(r));
      check('G: Technical Support Representative at 65', hasLead(r, 'Technical Support Representative', 65), leadTitles(r));
      check('G: 1 location reject (Kingston, Jamaica)', r.screened?.rejectedLocation === 1, r.screened);
      check('G: source page is the portal tp-jobs.html', typeof r.sourcePage === 'string' && r.sourcePage.includes('tp-jobs.html'), r.sourcePage);
    }

    // --- Teleperformance iCIMS (fixture T2: plain-HTML apply-link cards) ---
    {
      const r = await testCompany('MockTpIcims', `${BASE}/tp-icims.html`);
      summarize('T2 Teleperformance-iCIMS', r);
      check('T2: 4 postings seen (all 4 iCIMS cards parsed)', r.postingsSeen === 4, r.postingsSeen);
      check('T2: Customer Service Expert leads at 60', hasLead(r, 'Customer Service Expert', 60), leadTitles(r));
      check('T2: Customer Expert Nbs Fraud is a 55 near-miss', hasLead(r, 'Customer Expert Nbs Fraud', 55), leadTitles(r));
      check('T2: no render needed (plain HTML list)', r.renderUsed === false, r.renderUsed);
    }

    // --- TTEC (fixture C: TalentBrew, plain HTML, Strategy D) ---
    {
      const r = await testCompany('MockTTEC', `${BASE}/ttec.html`);
      summarize('C TTEC', r);
      check('C: 8 postings seen (page 1 of 38)', r.postingsSeen === 8, r.postingsSeen);
      check('C: 0 leads (Las Vegas role is on-site, rest non-US)', (r.leads ?? []).length === 0, leadTitles(r));
      check('C: Las Vegas CSR extracted (location reject, not a miss)', rejected(r, 'Customer Service Representative', 'Las Vegas, Nevada', 'location'), r.screened?.rejected);
      check('C: 6 location rejects', r.screened?.rejectedLocation === 6, r.screened);
      check('C: 2 no-match (non-English titles)', r.screened?.rejectedNoMatch === 2, r.screened);
      check('C: no render used', r.renderUsed === false, r.renderUsed);
    }

    // --- Alorica (fixture D: search submit -> real results) ---
    {
      const r = await testCompany('MockAlorica', `${BASE}/alorica.html`);
      summarize('D Alorica', r);
      check('D: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('D: 4 postings seen', r.postingsSeen === 4, r.postingsSeen);
      check('D: Customer Service Representative at 65', hasLead(r, 'Customer Service Representative', 65), leadTitles(r));
      check('D: Bilingual Customer Service Representative at 65', hasLead(r, 'Bilingual Customer Service Representative', 65), leadTitles(r));
      check('D: Customer Support Specialist at 65', hasLead(r, 'Customer Support Specialist', 65), leadTitles(r));
      check('D: exactly 3 leads (Warehouse Associate is no-match)', (r.leads ?? []).length === 3, leadTitles(r));
      check('D: render was used', r.renderUsed === true, r.renderUsed);
    }

    // --- Alorica zero-results (fixture D0) ---
    {
      const r = await testCompany('MockAloricaZero', `${BASE}/alorica-zero.html`);
      summarize('D0 AloricaZero', r);
      check('D0: search outcome is no-results', r.searchOutcome === 'no-results', r.searchOutcome);
      check('D0: 0 postings, 0 leads', r.postingsSeen === 0 && (r.leads ?? []).length === 0, { postings: r.postingsSeen, leads: r.leads });
    }

    // --- Alorica gated search (fixture D1: re-submit after the gate) ---
    {
      const r = await testCompany('MockAloricaGated', `${BASE}/alorica-gated.html`);
      summarize('D1 AloricaGated', r);
      check('D1: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('D1: 4 postings seen', r.postingsSeen === 4, r.postingsSeen);
      check('D1: exactly 3 leads at 65', (r.leads ?? []).length === 3 && hasLead(r, 'Customer Service Representative', 65), leadTitles(r));
      check('D1: gate log shows the "United States" pick', gateShows(r, 'United States'), r.renderAttempts);
    }

    // --- NexRep (fixture I: Paylocity board, non-CS — 0 leads correct) ---
    {
      const r = await testCompany('MockNexRep', `${BASE}/nexrep.html`);
      summarize('I NexRep', r);
      check('I: 3 postings seen (Share Your Information is junk)', r.postingsSeen === 3, r.postingsSeen);
      check('I: 0 leads is correct', (r.leads ?? []).length === 0, leadTitles(r));
      check('I: "Share Your Information" never surfaces as a posting', !(r.screened?.rejected ?? []).some((x) => x.title === 'Share Your Information'), r.screened?.rejected);
    }

    // --- NexRep JS portal (fixture I2) ---
    {
      const r = await testCompany('MockNexRepJS', `${BASE}/nexrep-js.html`);
      summarize('I2 NexRepJS', r);
      check('I2: 3 postings seen', r.postingsSeen === 3, r.postingsSeen);
      check('I2: 0 leads is correct', (r.leads ?? []).length === 0, leadTitles(r));
      check('I2: first render target is the Paylocity-shaped list URL', (r.renderTargets ?? [])[0]?.url.includes('/recruiting/jobs/All/') === true, r.renderTargets);
      check('I2: search outcome is has-listings (no tail drift)', r.searchOutcome === 'has-listings', r.searchOutcome);
      check('I2: exactly one render attempt', (r.renderAttempts ?? []).length === 1, r.renderAttempts);
    }

    // --- Working Solutions (fixture J: non-CS — 0 leads correct) ---
    {
      const r = await testCompany('MockWS', `${BASE}/ws.html`);
      summarize('J WorkingSolutions', r);
      check('J: 3 postings seen', r.postingsSeen === 3, r.postingsSeen);
      check('J: 0 leads is correct', (r.leads ?? []).length === 0, leadTitles(r));
    }

    // --- Working Solutions FAQ gate (fixture F4) ---
    {
      const r = await testCompany('MockWSFaq', `${BASE}/ws-faq.html`);
      summarize('F4 WorkingSolutionsFaq', r);
      check('F4: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('F4: landed on the US results page', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('ws-faq-us.html'), r.renderedUrl);
      check('F4: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('F4: gate log never shows any FAQ question', gateHides(r, 'CAN I APPLY') && gateHides(r, 'HOW DO I APPLY') && gateHides(r, 'WHAT IS WORKING'), r.renderAttempts);
      check('F4: gate log shows the "United States" pick', gateShows(r, 'United States'), r.renderAttempts);
    }

    // --- Omni (fixture F1: custom-dropdown gate behind site search) ---
    {
      const r = await testCompany('MockOmni', `${BASE}/omni.html`);
      summarize('F1 Omni', r);
      check('F1: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('F1: landed on the US results page', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('omni-us.html'), r.renderedUrl);
      check('F1: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('F1: gate log shows the US pick', (r.renderAttempts ?? []).some((a) => a.searchGateClicked === 'United States' && a.searchCountryClicked === 'United States'), r.renderAttempts);
    }

    // --- Omni bare country links (fixture F2) ---
    {
      const r = await testCompany('MockOmniLinks', `${BASE}/omni-links.html`);
      summarize('F2 OmniLinks', r);
      check('F2: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('F2: landed on the US results page', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('omni-us.html'), r.renderedUrl);
      check('F2: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('F2: gate log shows the bare "United States" pick', gateShows(r, 'United States'), r.renderAttempts);
    }

    // --- Omni blog-title gate (fixture F3) ---
    {
      const r = await testCompany('MockOmniBlog', `${BASE}/omni-blog.html`);
      summarize('F3 OmniBlog', r);
      check('F3: search outcome is searched (via the join portal)', r.searchOutcome === 'searched', r.searchOutcome);
      check('F3: landed on the join portal search results', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('omni-search.html'), r.renderedUrl);
      check('F3: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('F3: gate log never shows the blog article title', gateHides(r, 'Choose Your Schedule'), r.renderAttempts);
      check('F3: first attempt ended no-form (no blog detour)', (r.renderAttempts ?? [])[0]?.outcome === 'no-form', r.renderAttempts);
      check('F3: exactly two render attempts', (r.renderAttempts ?? []).length === 2, r.renderAttempts);
    }

    // --- Omni corporate careers (fixture K: no wrong gate pick) ---
    {
      const r = await testCompany('MockOmniCorp', `${BASE}/omni-corporate-careers.html`, `${BASE}/omni-join.html`);
      summarize('K OmniCorp', r);
      check('K: search outcome is searched', r.searchOutcome === 'searched', r.searchOutcome);
      check('K: landed on the search results page (via the join portal)', typeof r.renderedUrl === 'string' && r.renderedUrl.includes('omni-search.html'), r.renderedUrl);
      check('K: 3 US leads incl Remote CSR at 70', (r.leads ?? []).length === 3 && hasLead(r, 'Remote Customer Service Representative', 70), leadTitles(r));
      check('K: gate log never shows "Meet Our Leadership Team"', gateHides(r, 'Meet Our Leadership Team'), r.renderAttempts);
    }

    // --- Kelly (fixture H: JS-injected non-CS — 0 leads correct) ---
    {
      const r = await testCompany('MockKelly', `${BASE}/kelly.html`);
      summarize('H Kelly', r);
      check('H: 4 postings seen (JS-injected cards surfaced by the render)', r.postingsSeen === 4, r.postingsSeen);
      check('H: 0 leads is correct', (r.leads ?? []).length === 0, leadTitles(r));
      check('H: render was used', r.renderUsed === true, r.renderUsed);
    }

    // --- Probe mode (fixture P: markup outline end to end) ---
    {
      const pr = await fetch(`${RUNNER}/api/test-company`, {
        method: 'POST',
        headers: { 'x-sync-key': SYNC_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          company: { name: 'MockTPProbe', website: `${BASE}/tp-jobs.html`, careersUrl: `${BASE}/tp-jobs.html` },
          resumeText: RESUME,
          probe: true,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const p = await pr.json();
      const anchors = p.markup?.anchors ?? [];
      log(`P probe: status=${pr.status} outcome=${p.searchOutcome} anchors=${JSON.stringify(anchors.map((a) => a.text))} parsed=${p.markup?.parsedPostings} countLines=${JSON.stringify(p.markup?.countLines)}`);
      check('P: probe answers 200 with probe:true', pr.status === 200 && p.probe === true, { status: pr.status, probe: p.probe });
      check('P: probe search outcome is searched', p.searchOutcome === 'searched', p.searchOutcome);
      check('P: probe outline lists the 4 TP job anchors', anchors.length === 4 && anchors.some((a) => a.text === 'Customer Service Representative'), anchors);
      check('P: probe outline parsed count agrees with the extractor (4)', p.markup?.parsedPostings === 4, p.markup?.parsedPostings);
      check('P: probe outline carries the results-count line', (p.markup?.countLines ?? []).some((l) => /of 4/.test(l)), p.markup?.countLines);
    }

    // --- No-fixture employers: recorded, never failed ---
    for (const name of ['Concentrix', 'Sutherland', 'Day Kimball', 'NSSF', 'AIR']) {
      skipped.push(`${name} (no local-verify fixture — live canary only)`);
      log(`SKIP ${name}: no fixture exists; covered only by the live canary after deployment`);
    }
  } finally {
    await stopRunner();
    await new Promise((resolve) => fixtureHttp.close(resolve));
  }

  console.log(`\nCANARY-RESULT passes=${passes} failures=${failures} skipped=${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP: ${s}`);
  if (failures === 0) {
    console.log('LOCAL-FIXTURE-CANARY-ALL-PASS');
    return 0;
  }
  console.log(`LOCAL-FIXTURE-CANARY-${failures}-FAILURES`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`CANARY-ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
