#!/usr/bin/env node
/* Live canary for the finder-runner — the 14-employer ground-truth set
 * + Day Kimball, run against the runner server (Chromium ENABLED).
 * This is the LIVE counterpart of canary-fixtures.mjs: it fetches the
 * real employer careers pages, so it proves the reader works on the
 * host it runs on (GitHub Actions, where Chromium can download and
 * run — the VM cannot run Chromium, so this canary cannot run there).
 *
 * How it runs:
 *   1. Spawns the runner server bundle on 127.0.0.1:8081 with the
 *      SYNC_KEY env var (throwaway default for local runs).
 *   2. POSTs one /api/test-company per employer with the resume text.
 *   3. Writes results to canary-live-results.json and prints a summary.
 *   4. Exits 0 iff every employer answered (leads may be 0 for some —
 *      the summary is the verdict, not the exit code).
 *
 * ENV:
 *   RUNNER_PORT   runner server port (default 8081)
 *   SYNC_KEY      key for the local runner (default live-canary-test-key)
 *   RESUME_PATH   resume text (default demo-resumes/demo-customer-service.txt)
 *   OUT_PATH      results JSON (default canary-live-results.json)
 *   TIMEOUT_MS    per-company HTTP timeout (default 120000)
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RUNNER_PORT ?? 8081);
const SYNC_KEY = process.env.SYNC_KEY ?? 'live-canary-test-key';
const RESUME_PATH = process.env.RESUME_PATH ?? path.resolve(__dirname, '..', '..', 'demo-resumes', 'demo-customer-service.txt');
const OUT_PATH = process.env.OUT_PATH ?? path.resolve(process.cwd(), 'canary-live-results.json');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120000);

const EMPLOYERS = [
  ['Foundever', 'https://foundever.com'],
  ['Sitel', 'https://www.sitel.com'],
  ['TTEC', 'https://www.ttecjobs.com'],
  ['Omni Interactions', 'https://www.omniinteractions.com'],
  ['Teleperformance', 'https://jobs.teleperformance.com'],
  ['Concentrix', 'https://jobs.concentrix.com/job-search/'],
  ['Sutherland', 'https://www.sutherlandglobal.com'],
  ['Liveops', 'https://www.liveops.com'],
  ['ModSquad', 'https://modsquad.com'],
  ['Arise', 'https://www.ariseworkfromhome.com'],
  ['Alorica', 'https://www.alorica.com'],
  ['Kelly Services', 'https://www.kellyservices.us'],
  ['NexRep', 'https://nexrep.com'],
  ['Working Solutions', 'https://www.workingsolutions.com'],
  ['Day Kimball', 'https://www.daykimball.org'],
];

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(ms));
}

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  const resumeText = await readFile(RESUME_PATH, 'utf-8');
  const bundle = path.resolve(__dirname, 'dist-server', 'server.mjs');
  log(`starting runner server: node ${bundle} (port ${PORT})`);
  const serverProc = spawn(process.execPath, [bundle], {
    env: { ...process.env, PORT: String(PORT), SYNC_KEY, WARMUP_CHROMIUM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim()) log(`[finder] ${line.trim()}`);
    }
  });
  serverProc.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim()) log(`[finder:err] ${line.trim()}`);
    }
  });

  const base = `http://127.0.0.1:${PORT}`;
  if (!(await waitForHealth(base, 180000))) {
    serverProc.kill('SIGKILL');
    throw new Error('runner server never became healthy');
  }
  log('runner server healthy');

  const results = [];
  for (const [name, website] of EMPLOYERS) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/api/test-company`, {
        method: 'POST',
        headers: { 'x-sync-key': SYNC_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ company: { name, website }, resumeText }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await r.json();
      const leads = Array.isArray(data.leads) ? data.leads : [];
      const entry = {
        company: name,
        website,
        http: r.status,
        ms: Date.now() - t0,
        postings: data.postings ?? data.postingsSeen ?? null,
        leads: leads.length,
        leadTitles: leads.slice(0, 5).map((l) => `${l.title} (${l.matchScore ?? l.score ?? '?'})`),
        renderUsed: data.renderUsed ?? null,
        source: data.source ?? null,
      };
      results.push(entry);
      log(`${name}: postings=${entry.postings} leads=${entry.leads} renderUsed=${entry.renderUsed} ${entry.leadTitles.join(' | ')}`);
    } catch (e) {
      results.push({ company: name, website, http: null, ms: Date.now() - t0, error: String(e) });
      log(`${name}: ERROR ${e}`);
    }
  }

  serverProc.kill('SIGTERM');
  await new Promise((resolve) => {
    serverProc.on('exit', resolve);
    setTimeout(resolve, 10000);
  });

  const totalLeads = results.reduce((s, r) => s + (r.leads || 0), 0);
  const withLeads = results.filter((r) => (r.leads || 0) > 0).length;
  const rendered = results.filter((r) => r.renderUsed).length;
  const summary = {
    ranAt: new Date().toISOString(),
    resume: path.basename(RESUME_PATH),
    totalLeads,
    employersWithLeads: withLeads,
    employersRendered: rendered,
    results,
  };
  await writeFile(OUT_PATH, JSON.stringify(summary, null, 2));
  log(`CANARY-LIVE totalLeads=${totalLeads} employersWithLeads=${withLeads}/15 rendered=${rendered}/15 -> ${OUT_PATH}`);
  log(`employers with leads: ${results.filter((r) => (r.leads || 0) > 0).map((r) => `${r.company}(${r.leads})`).join(', ') || 'NONE'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
