/* JobBoard finder-runner server — Node http adapter for the finder
 * API handlers ONLY (/api/find-jobs, /api/test-company).
 *
 * This is a FORK of cloud-run/server/server.mjs (piece (a)), kept
 * deliberately separate because the two images have OPPOSITE render
 * policies:
 *   - The service adapter forces JOBBOARD_NO_RENDER=1 at import (its
 *     three-layer kill-switch) and serves the SPA. The runner MUST
 *     render — Chromium is the whole point of this image — so it
 *     cannot import that file or its bundle.
 *   - The runner serves NO static files and NO other /api/* routes:
 *     it is a headless job container whose only client is the sweep
 *     driver (find-jobs) plus the fixture canary (test-company).
 * The adapter half (Vercel req/res translation, body parsing, access
 * log) is copied verbatim from the service adapter so the two stay
 * behavior-identical on the routes they share. If the adapter logic
 * changes, change it in BOTH files.
 *
 * Bundled by cloud-run/runner/build.sh (esbuild, ESM; mongodb,
 * @sparticuz/chromium-min and puppeteer-core external — same reason
 * as the service bundle: dynamic require('events') in the browser
 * packages' dep tree breaks esbuild's ESM __require shim).
 * Run the bundle: node cloud-run/runner/dist-server/server.mjs
 *
 * CHROMIUM WARMUP: on startup (unless WARMUP_CHROMIUM=0) the server
 * resolves the Chromium binary once via @sparticuz/chromium-min, so
 * the ~70MB pack download from GitHub releases happens at container
 * start, NOT inside the first render's 20s timeout (render-page.ts
 * gives getBrowser() the render's remaining budget — a cold download
 * inside it can time out and burn the chunk's render). Warmup failure
 * is logged and non-fatal: the first render retries the download
 * exactly like the Vercel function does. The pack URL is pinned to
 * the same v153.0.0 release render-page.ts uses; keep the two in sync.
 * The binary extracts to os.tmpdir() (/tmp on Cloud Run, writable).
 *
 * ROUTES
 *   POST /api/find-jobs     → api/find-jobs.ts (chunked sweep; needs
 *                             MONGODB_URI + SYNC_KEY)
 *   POST /api/test-company  → api/test-company.ts (single-company
 *                             test + probe mode; needs SYNC_KEY only)
 *   GET  /healthz           → {"ok":true} (driver readiness probe)
 *   GET  /readyz            → {"ok":true,"chromium":"ready|warming|
 *                             failed|disabled"} (Chromium warmup state)
 *
 * ENV
 *   PORT             listen port (default 8080)
 *   WARMUP_CHROMIUM  '1' (default) or '0'
 *   MONGODB_URI, SYNC_KEY   passed through to the handlers
 *   TMPDIR           where the Chromium pack extracts (default /tmp)
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import findJobsHandler from '../../api/find-jobs.ts';
import testCompanyHandler from '../../api/test-company.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);

/** Max JSON body: find-jobs posts carry the resume text (~3KB); 2MB
 *  leaves wide headroom and still bounds abuse. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Pinned Chromium pack — MUST match api/render-page.ts
 *  CHROMIUM_PACK_URL. The runner resolves this same pack at warmup. */
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar';

const ROUTES = new Map([
  ['/api/find-jobs', findJobsHandler],
  ['/api/test-company', testCompanyHandler],
]);

/* ------------------------------------------------------------------ */
/* Chromium warmup                                                     */
/* ------------------------------------------------------------------ */

/** 'warming' until the startup resolve settles, then 'ready' or
 *  'failed'; 'disabled' when WARMUP_CHROMIUM=0. */
let chromiumState = process.env.WARMUP_CHROMIUM === '0' ? 'disabled' : 'warming';

async function warmupChromium() {
  if (chromiumState === 'disabled') return;
  const started = Date.now();
  try {
    // Static import at the top would make the module load depend on
    // the loader package; a dynamic import keeps a loader failure
    // from killing the server before it can even listen.
    const { default: chromium } = await import('@sparticuz/chromium-min');
    chromium.setGraphicsMode = false;
    const exe = await chromium.executablePath(CHROMIUM_PACK_URL);
    chromiumState = 'ready';
    console.log(`chromium warmup ready in ${Date.now() - started}ms: ${exe}`);
  } catch (e) {
    chromiumState = 'failed';
    console.log(
      `chromium warmup FAILED after ${Date.now() - started}ms (non-fatal; first render retries the download): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* API adapter (copied from cloud-run/server/server.mjs — keep in sync) */
/* ------------------------------------------------------------------ */

/** Build the VercelRequest the handlers expect from a Node request. */
function buildVercelRequest(nodeReq, url, body) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (key in query) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }
  return {
    method: nodeReq.method,
    headers: nodeReq.headers,
    query,
    body,
  };
}

/** Build the VercelResponse the handlers expect on top of a Node
 *  response. Guards double-send: a handler that answers twice (it
 *  shouldn't) keeps only its first answer. */
function buildVercelResponse(nodeRes) {
  let sent = false;
  return {
    status(code) {
      return {
        json(body) {
          if (sent) return;
          sent = true;
          const payload = JSON.stringify(body ?? null);
          nodeRes.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'cache-control': 'no-store',
          });
          nodeRes.end(payload);
        },
      };
    },
  };
}

/** Read + parse the request body. Returns undefined for an empty
 *  body. Throws { status, message } on bad JSON or oversize bodies. */
async function readBody(nodeReq) {
  const contentType = String(nodeReq.headers['content-type'] ?? '');
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeReq) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!contentType.includes('application/json')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function sendJson(nodeRes, code, body) {
  const payload = JSON.stringify(body);
  nodeRes.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  nodeRes.end(payload);
}

async function handleApi(nodeReq, nodeRes, url, pathname) {
  const handler = ROUTES.get(pathname);
  if (!handler) {
    sendJson(nodeRes, 404, { error: 'not found' });
    return 404;
  }
  let body;
  try {
    body = await readBody(nodeReq);
  } catch (e) {
    const code = e.status ?? 400;
    sendJson(nodeRes, code, { error: e.message });
    return code;
  }
  const req = buildVercelRequest(nodeReq, url, body);
  const res = buildVercelResponse(nodeRes);
  // Capture the status for the access log.
  let statusCode = 200;
  const origWriteHead = nodeRes.writeHead.bind(nodeRes);
  nodeRes.writeHead = (code, ...rest) => {
    statusCode = code;
    return origWriteHead(code, ...rest);
  };
  try {
    await handler(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    if (!nodeRes.writableEnded) sendJson(nodeRes, 500, { error: msg });
    statusCode = 500;
  }
  return statusCode;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (nodeReq, nodeRes) => {
  const started = Date.now();
  const method = nodeReq.method ?? 'GET';
  let url;
  try {
    url = new URL(nodeReq.url ?? '/', 'http://localhost');
  } catch {
    sendJson(nodeRes, 400, { error: 'bad request' });
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  let status = 500;
  try {
    if (method === 'OPTIONS') {
      nodeRes.writeHead(204, {
        allow: 'GET, POST, OPTIONS',
        'content-length': '0',
      });
      nodeRes.end();
      status = 204;
    } else if (pathname === '/healthz') {
      sendJson(nodeRes, 200, { ok: true, service: 'jobboard-runner' });
      status = 200;
    } else if (pathname === '/readyz') {
      sendJson(nodeRes, 200, { ok: true, chromium: chromiumState });
      status = 200;
    } else if (pathname.startsWith('/api/')) {
      status = await handleApi(nodeReq, nodeRes, url, pathname);
    } else {
      sendJson(nodeRes, 404, { error: 'not found' });
      status = 404;
    }
  } catch (e) {
    if (!nodeRes.writableEnded) {
      sendJson(nodeRes, 500, { error: e instanceof Error ? e.message : 'failed' });
    }
    status = 500;
  }
  console.log(`${method} ${pathname} -> ${status} ${Date.now() - started}ms`);
});

server.listen(PORT, () => {
  console.log(`jobboard runner listening on :${PORT} (chromium: ${chromiumState})`);
  // Warmup runs AFTER listen so the driver / health checks never
  // wait on the ~70MB download to start probing.
  void warmupChromium();
});

// Cloud Run Jobs sends SIGTERM when the task is stopped: stop taking
// connections, then exit. The driver owns shutdown ordering (it kills
// this server after the sweep), so this is a backstop only.
server.on('error', (e) => {
  console.error('server error:', e);
  process.exit(1);
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
