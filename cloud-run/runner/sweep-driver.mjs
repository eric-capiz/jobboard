#!/usr/bin/env node
/* JobBoard finder sweep driver — loops /api/find-jobs chunks against a
 * runner server and checkpoints after every chunk, so a killed run
 * resumes from the last cursor instead of from zero.
 *
 * This is the Node port of the Python sweep workers
 * (sweep-2026-11-12-cs-v6/worker-*.py): same request shape, same
 * retry-then-skip-a-cursor policy, same checkpoint fields — so a run
 * driven by this file is comparable to the Vercel sweeps chunk for
 * chunk. Differences are only where the Cloud Run Job needs them:
 *   - the finder server is managed HERE: by default the driver spawns
 *     the runner server (cloud-run/runner/dist-server/server.mjs) as
 *     a child process on 127.0.0.1 and kills it when the sweep ends,
 *     because a Cloud Run Job runs ONE container = ONE command. Set
 *     FINDER_MANAGED_SERVER=0 to point at an already-running server
 *     instead (local testing, or a shared service).
 *   - render throttle: RENDER_DELAY_MS sleeps between chunks that
 *     used a render, and MAX_RENDERS_PER_HOUR caps render attempts
 *     in any rolling hour (see the throttle math in runner-NOTES.md).
 *     Renders are the expensive part of a sweep; the throttle is what
 *     keeps a full sweep inside the Cloud Run Jobs free tier.
 *   - the sync key is read from a FILE at runtime (SYNC_KEY_PATH)
 *     and re-read on a 401/403, exactly like the Python workers. It
 *     is NEVER printed: logs name the key file, never its content.
 *
 * The driver NEVER fetches an employer site itself — every request
 * goes to the runner server, which does the fetching. It NEVER writes
 * to the board directly: with AUTO_ADD=true the server appends
 * qualifying leads (score >= 60, remote-US, deduped by title+company)
 * exactly like the Vercel sweep path.
 *
 * ENV (all optional except RESUME_PATH and SYNC_KEY_PATH):
 *   FINDER_BASE_URL       runner base URL (default http://127.0.0.1:8080)
 *   FINDER_MANAGED_SERVER '1' (default) spawn the server; '0' use an
 *                         existing one at FINDER_BASE_URL
 *   FINDER_PORT           port for the managed server (default 8080)
 *   RESUME_PATH           path to the resume text file (required)
 *   SYNC_KEY_PATH         path to the file holding the sync key (required)
 *   RESUME_LABEL          resumeLabel sent with each chunk
 *                         (default demo-customer-service)
 *   AUTO_ADD              'true' (default) or 'false'
 *   LIMIT                 companies per chunk (default 25, server max)
 *   CHECKPOINT_PATH       where the checkpoint JSON lives
 *                         (default ./sweep-checkpoint.json)
 *   SWEEP_END             stop when cursor >= this value (optional cap)
 *   MAX_CHUNKS            stop after this many chunks (optional, testing)
 *   RENDER_DELAY_MS       sleep after a chunk that used a render
 *                         (default 5000)
 *   MAX_RENDERS_PER_HOUR  rolling-hour cap on render attempts
 *                         (default 120)
 *   CHUNK_TIMEOUT_MS      per-chunk HTTP timeout (default 120000)
 *   RETRY_DELAY_MS        sleep between chunk retries (default 5000)
 *   MAX_ATTEMPTS          attempts per chunk before skipping it
 *                         (default 3)
 *
 * CHECKPOINT (written atomically — tmp file + rename — after every
 * chunk, and read back on start): cursor, checked, leads, autoAdded,
 * statsTotals, failedCursors, renderTimestamps, startedAt, updatedAt,
 * done. A corrupt checkpoint logs a warning and starts fresh.
 * NOTE: on Cloud Run the checkpoint lives at CHECKPOINT_PATH inside
 * the container (job.yaml points it at /tmp). A retried task attempt
 * is a NEW container, so it does NOT see the old checkpoint — it
 * restarts from cursor 0, which is safe (server auto-add dedupes by
 * title+company) but wasteful. A persistent checkpoint (GCS volume)
 * is a future improvement, not wired here — see runner-NOTES.md.
 *
 * EXIT CODES: 0 = sweep finished (done, SWEEP_END, or MAX_CHUNKS)
 * even with some failed cursors (they are recorded in the checkpoint
 * and the summary); 1 = unrecoverable (resume/key unreadable,
 * server never healthy, auth failing on every chunk, checkpoint
 * unwritable). A 1 on a Job task triggers a retry (maxRetries 3).
 */

import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.FINDER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const MANAGED_SERVER = process.env.FINDER_MANAGED_SERVER !== '0';
const FINDER_PORT = Number(process.env.FINDER_PORT ?? 8080);
const RESUME_PATH = process.env.RESUME_PATH ?? '';
const SYNC_KEY_PATH = process.env.SYNC_KEY_PATH ?? '';
const RESUME_LABEL = process.env.RESUME_LABEL ?? 'demo-customer-service';
const AUTO_ADD = process.env.AUTO_ADD !== 'false';
const LIMIT = Math.min(25, Math.max(1, Number(process.env.LIMIT ?? 25) || 25));
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH ?? path.resolve(process.cwd(), 'sweep-checkpoint.json');
const SWEEP_END = process.env.SWEEP_END ? Number(process.env.SWEEP_END) : null;
const MAX_CHUNKS = process.env.MAX_CHUNKS ? Number(process.env.MAX_CHUNKS) : null;
const RENDER_DELAY_MS = Number(process.env.RENDER_DELAY_MS ?? 5000);
const MAX_RENDERS_PER_HOUR = Number(process.env.MAX_RENDERS_PER_HOUR ?? 120);
const CHUNK_TIMEOUT_MS = Number(process.env.CHUNK_TIMEOUT_MS ?? 120000);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 5000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.MAX_ATTEMPTS ?? 3));

const STARTED_AT = new Date().toISOString();
const HOUR_MS = 60 * 60 * 1000;

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readSecretFile(filePath, what) {
  const raw = await readFile(filePath, 'utf-8');
  const value = raw.trim();
  if (!value) throw new Error(`${what} file is empty: ${filePath}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Checkpoint                                                          */
/* ------------------------------------------------------------------ */

let state = {
  driver: 'jobboard-runner-sweep-driver',
  version: 1,
  resumeLabel: RESUME_LABEL,
  checked: 0,
  leads: [],
  autoAdded: 0,
  statsTotals: {},
  failedCursors: [],
  renderTimestamps: [],
  lastCursor: 0,
  startedAt: STARTED_AT,
  updatedAt: STARTED_AT,
  done: false,
};

async function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return false;
  try {
    const raw = await readFile(CHECKPOINT_PATH, 'utf-8');
    const ck = JSON.parse(raw);
    if (typeof ck !== 'object' || ck === null || typeof ck.lastCursor !== 'number') {
      throw new Error('checkpoint has no numeric lastCursor');
    }
    state = {
      ...state,
      ...ck,
      resumeLabel: RESUME_LABEL,
      startedAt: ck.startedAt ?? STARTED_AT,
    };
    // Leads can be large; keep only well-formed entries.
    if (!Array.isArray(state.leads)) state.leads = [];
    if (!Array.isArray(state.failedCursors)) state.failedCursors = [];
    if (!Array.isArray(state.renderTimestamps)) state.renderTimestamps = [];
    if (typeof state.statsTotals !== 'object' || state.statsTotals === null) state.statsTotals = {};
    log(
      `resumed from checkpoint ${CHECKPOINT_PATH}: cursor=${state.lastCursor} checked=${state.checked} leads=${state.leads.length} autoAdded=${state.autoAdded} failed=${JSON.stringify(state.failedCursors)}`,
    );
    return true;
  } catch (e) {
    log(`WARNING: checkpoint unreadable (${e.message}); starting fresh`);
    return false;
  }
}

async function saveCheckpoint() {
  state.updatedAt = new Date().toISOString();
  // The checkpoint must never carry the resume text or the base URL
  // override — both are runtime inputs, not progress. (The resume is
  // the user's own document; the checkpoint is just progress.)
  const { resumeText: _resumeText, baseUrl: _baseUrl, ...persisted } = state;
  const tmp = `${CHECKPOINT_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(persisted), 'utf-8');
  await rename(tmp, CHECKPOINT_PATH);
}

/* ------------------------------------------------------------------ */
/* Managed finder server                                               */
/* ------------------------------------------------------------------ */

let serverProc = null;

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

async function startManagedServer(syncKey) {
  const bundle = path.resolve(__dirname, 'dist-server', 'server.mjs');
  if (!existsSync(bundle)) {
    throw new Error(`runner server bundle not found: ${bundle} (run cloud-run/runner/build.sh)`);
  }
  log(`starting managed finder server: node ${bundle} (port ${FINDER_PORT})`);
  serverProc = spawn(process.execPath, [bundle], {
    env: {
      ...process.env,
      PORT: String(FINDER_PORT),
      SYNC_KEY: syncKey,
    },
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
  serverProc.on('exit', (code, signal) => {
    log(`[finder] server exited code=${code} signal=${signal}`);
  });
  const base = `http://127.0.0.1:${FINDER_PORT}`;
  if (!(await waitForHealth(base, 90000))) {
    throw new Error(`managed finder server never became healthy at ${base}/healthz`);
  }
  log(`managed finder server healthy at ${base}`);
  return base;
}

async function stopManagedServer() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
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
/* Chunk loop                                                          */
/* ------------------------------------------------------------------ */

let syncKey = '';
let resumeText = '';
let baseUrl = BASE_URL;

async function postChunk(cursor) {
  const body = JSON.stringify({
    resumeText,
    cursor,
    limit: LIMIT,
    autoAdd: AUTO_ADD,
    resumeLabel: RESUME_LABEL,
  });
  const r = await fetch(`${baseUrl}/api/find-jobs`, {
    method: 'POST',
    headers: { 'x-sync-key': syncKey, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
  });
  if (r.status === 401 || r.status === 403) {
    const err = new Error(`HTTP ${r.status}`);
    err.code = r.status;
    throw err;
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    err.code = r.status;
    throw err;
  }
  return r.json();
}

function mergeStats(stats) {
  if (!stats || typeof stats !== 'object') return;
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      state.statsTotals[k] = (state.statsTotals[k] ?? 0) + v;
    }
  }
}

/** Rolling-hour render cap: sleep until the oldest render attempt in
 *  the last hour falls out of the window. Logs while waiting. */
async function enforceRenderCap() {
  for (;;) {
    const now = Date.now();
    state.renderTimestamps = state.renderTimestamps.filter((t) => now - t < HOUR_MS);
    if (state.renderTimestamps.length < MAX_RENDERS_PER_HOUR) return;
    const oldest = Math.min(...state.renderTimestamps);
    const waitMs = oldest + HOUR_MS - now + 1000;
    log(
      `render cap reached (${state.renderTimestamps.length}/${MAX_RENDERS_PER_HOUR} in the last hour); sleeping ${Math.ceil(waitMs / 1000)}s`,
    );
    await sleep(Math.min(waitMs, 60000));
  }
}

async function main() {
  if (!RESUME_PATH) throw new Error('RESUME_PATH is required');
  if (!SYNC_KEY_PATH) throw new Error('SYNC_KEY_PATH is required');
  // A cap of 0 would deadlock enforceRenderCap (nothing can ever
  // fall out of an empty window); fail fast instead.
  if (!(MAX_RENDERS_PER_HOUR >= 1)) {
    throw new Error('MAX_RENDERS_PER_HOUR must be >= 1');
  }

  resumeText = await readSecretFile(RESUME_PATH, 'resume');
  syncKey = await readSecretFile(SYNC_KEY_PATH, 'sync key');
  log(
    `sweep driver starting: base=${BASE_URL} managedServer=${MANAGED_SERVER} resumeLabel=${RESUME_LABEL} autoAdd=${AUTO_ADD} limit=${LIMIT} checkpoint=${CHECKPOINT_PATH} renderDelayMs=${RENDER_DELAY_MS} maxRendersPerHour=${MAX_RENDERS_PER_HOUR}`,
  );

  await loadCheckpoint();
  if (state.done) {
    log('checkpoint already says done; nothing to do.');
    return 0;
  }

  baseUrl = BASE_URL;
  if (MANAGED_SERVER) {
    baseUrl = await startManagedServer(syncKey);
  } else if (!(await waitForHealth(baseUrl, 30000))) {
    throw new Error(`finder server not healthy at ${baseUrl}/healthz (FINDER_MANAGED_SERVER=0)`);
  }

  let cursor = state.lastCursor;
  let chunks = 0;
  let authRefreshed = false;

  try {
    while (true) {
      if (SWEEP_END !== null && cursor >= SWEEP_END) {
        log(`stopping: cursor ${cursor} reached SWEEP_END ${SWEEP_END}`);
        break;
      }
      if (MAX_CHUNKS !== null && chunks >= MAX_CHUNKS) {
        log(`stopping: MAX_CHUNKS ${MAX_CHUNKS} reached`);
        break;
      }

      await enforceRenderCap();

      let result = null;
      let lastErr = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await postChunk(cursor);
          break;
        } catch (e) {
          lastErr = `${e.name ?? 'Error'}: ${e.message}`;
          if ((e.code === 401 || e.code === 403) && !authRefreshed) {
            try {
              syncKey = await readSecretFile(SYNC_KEY_PATH, 'sync key');
              authRefreshed = true;
              log(`cursor=${cursor} got ${e.code}; re-read key file, retrying`);
              if (MANAGED_SERVER && serverProc) {
                // The managed server got its SYNC_KEY at spawn; a
                // rotated key needs a server restart to take effect.
                log('restarting managed server so the re-read key takes effect');
                await stopManagedServer();
                baseUrl = await startManagedServer(syncKey);
              }
              continue;
            } catch (ke) {
              lastErr = `HTTP ${e.code} (key re-read failed: ${ke.message})`;
              break;
            }
          }
          log(`cursor=${cursor} attempt ${attempt} failed: ${lastErr}`);
          if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
      }

      if (result === null) {
        state.failedCursors.push(cursor);
        log(`DOUBLE FAILURE cursor=${cursor} err=${lastErr}; skipping to ${cursor + LIMIT}`);
        cursor += LIMIT;
        state.lastCursor = cursor;
        await saveCheckpoint();
        continue;
      }

      const newLeads = Array.isArray(result.leads) ? result.leads : [];
      state.leads.push(...newLeads);
      state.checked += result.checked ?? 0;
      state.autoAdded += result.autoAdded ?? 0;
      mergeStats(result.stats);
      const rendersInChunk = result.stats?.renderAttempts ?? 0;
      const now = Date.now();
      for (let i = 0; i < rendersInChunk; i++) state.renderTimestamps.push(now);
      const nextCursor = result.nextCursor ?? null;
      chunks += 1;
      log(
        `chunk ${chunks}: cursor=${cursor} checked+${result.checked} total_checked=${state.checked} leads+${newLeads.length} total_leads=${state.leads.length} autoAdded+${result.autoAdded ?? 0} total_autoAdded=${state.autoAdded} renders=${rendersInChunk} nextCursor=${nextCursor} done=${result.done}`,
      );
      if (nextCursor === null || result.done === true) {
        state.done = true;
        state.lastCursor = cursor + (result.checked ?? 0);
        await saveCheckpoint();
        break;
      }
      cursor = nextCursor;
      state.lastCursor = cursor;
      await saveCheckpoint();
      if (rendersInChunk > 0 && RENDER_DELAY_MS > 0) {
        log(`render used in chunk; sleeping ${RENDER_DELAY_MS}ms (RENDER_DELAY_MS)`);
        await sleep(RENDER_DELAY_MS);
      }
    }
  } finally {
    await stopManagedServer();
  }

  const elapsedMin = ((Date.now() - Date.parse(STARTED_AT)) / 60000).toFixed(1);
  const rendersTotal = state.statsTotals.renderAttempts ?? 0;
  log(
    `FINISHED checked=${state.checked} leads=${state.leads.length} autoAdded=${state.autoAdded} renders=${rendersTotal} failedCursors=${JSON.stringify(state.failedCursors)} chunks=${chunks} elapsedMin=${elapsedMin} done=${state.done}`,
  );
  console.log(
    JSON.stringify(
      {
        summary: true,
        checked: state.checked,
        leads: state.leads.length,
        autoAdded: state.autoAdded,
        renders: rendersTotal,
        failedCursors: state.failedCursors,
        chunks,
        elapsedMin: Number(elapsedMin),
        done: state.done,
        lastCursor: state.lastCursor,
      },
      null,
      2,
    ),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // The key value is never in an error message (it is only ever
    // read from its file); still, never log a raw error that could
    // carry request headers.
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
