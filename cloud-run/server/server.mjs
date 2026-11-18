/* JobBoard Cloud Run service — Node http adapter for the Vercel
 * serverless API handlers in api/ plus the Vite SPA in dist/.
 *
 * No new dependencies: node:http + node:fs only. The api handlers
 * are bundled with the entry by cloud-run/server/build.sh (esbuild,
 * ESM; mongodb, @sparticuz/chromium-min and puppeteer-core external
 * — see build.sh for why) into cloud-run/server/dist-server/server.mjs;
 * run that file with node. `npm run build` (tsc + vite build) still
 * produces dist/ the same way; this file only serves it.
 *
 * RENDERING IS DISABLED IN THIS SERVICE — by design, not by
 * accident. The UI/API image serves the board and runs the
 * plain-HTML job search only; browser rendering (Chromium) belongs
 * to the finder runner image. Enforcement is three layers deep:
 *   1. This file forces process.env.JOBBOARD_NO_RENDER = '1' at
 *      startup, before any request is handled (overrides any
 *      inherited env — a service that never renders must not depend
 *      on whoever launched it remembering a flag).
 *   2. Dockerfile.service also sets ENV JOBBOARD_NO_RENDER=1.
 *   3. The leaf itself, api/render-page.ts renderDisabled(), returns
 *      null from renderPageHtml() immediately when the flag is '1',
 *      before any browser code runs — getBrowser() (the only place
 *      that downloads/launches Chromium) is never reached.
 * With the flag on, a render call is a ~0ms null: find-jobs.ts
 * records it as a 'render-null' attempt and moves on (api/find-jobs.ts
 * ~line 2196), and test-company probe mode answers render-null with
 * no markup (api/test-company.ts ~line 208). No api/ or tests/ code
 * was changed for this — the kill-switch already existed and the
 * offline suite already covers it (tests/finder.test.mjs sets
 * JOBBOARD_NO_RENDER=1 at the top and asserts probe → render-null,
 * ~line 5488). The @sparticuz/chromium-min + puppeteer-core imports
 * are load-time inert: the package's only module-load side effect
 * is an Amazon-Linux-2023 env setup that does not trigger here, and
 * the ~70MB Chromium download happens only inside
 * chromium.executablePath(), called only from getBrowser().
 *
 * ROUTES
 *   /api/state, /api/companies, /api/companies/import,
 *   /api/companies/migrate, /api/find-companies, /api/find-jobs,
 *   /api/test-company, /api/jobs  → the matching api/*.ts default handler.
 *   /healthz            → {"ok":true} (Cloud Run health check).
 *   everything else     → dist/ static file, SPA fallback to
 *                          dist/index.html for GET/HEAD.
 * /api/companies/import and /api/companies/migrate are routed even
 * though the migration brief listed only five endpoints: the UI
 * calls both (src/store/index.tsx, src/components/FinderView.tsx),
 * and parity with the Vercel deployment means the UI must keep
 * working. They are the same adapter path as the other five — no
 * special handling.
 *
 * VERCEL SHAPE TRANSLATION
 * Each handler expects (VercelRequest, VercelResponse):
 *   req: { method, headers (lowercased), query, body }
 *   res: { status(code).json(body) }
 * The adapter builds those from the Node req: headers pass through
 * as-is (Node already lowercases them), the query string becomes
 * Record<string, string | string[]> (repeated keys → array, matching
 * Vercel), and a JSON body is parsed (bad JSON → 400, oversize
 * bodies → 413). Auth, MongoDB, and all business logic stay in the
 * handlers untouched.
 *
 * ENV
 *   PORT            listen port (default 8080, Cloud Run's default)
 *   STATIC_DIR      override for the dist/ directory (default:
 *                   ../../../dist relative to this file — i.e.
 *                   <repo>/dist for both the bundle and a direct
 *                   `node server.mjs` run — falling back to ./dist
 *                   under the working directory)
 *   MONGODB_URI, SYNC_KEY   passed through to the handlers
 *   JOBBOARD_NO_RENDER      forced to '1' here (see above)
 */

import http from 'node:http';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Layer 1 of the render kill-switch (see header). Set before any
// handler runs. Nothing reads this flag at import time —
// render-page.ts checks it inside renderPageHtml() on every call —
// so assignment here, ahead of the imports below, is airtight for
// the whole process lifetime.
process.env.JOBBOARD_NO_RENDER = '1';

import stateHandler from '../../api/state.ts';
import companiesHandler from '../../api/companies.ts';
import companiesImportHandler from '../../api/companies/import.ts';
import companiesMigrateHandler from '../../api/companies/migrate.ts';
import findCompaniesHandler from '../../api/find-companies.ts';
import findJobsHandler from '../../api/find-jobs.ts';
import testCompanyHandler from '../../api/test-company.ts';
import checkLinkHandler from '../../api/check-link.ts';
import jobsHandler from '../../api/jobs.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);

/** Max JSON body: the state doc PUT is ~4.5MB (Vercel's old payload
 *  ceiling); 10MB leaves headroom and still bounds abuse. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const ROUTES = new Map([
  ['/api/state', stateHandler],
  ['/api/companies', companiesHandler],
  ['/api/companies/import', companiesImportHandler],
  ['/api/companies/migrate', companiesMigrateHandler],
  ['/api/find-companies', findCompaniesHandler],
  ['/api/find-jobs', findJobsHandler],
  ['/api/test-company', testCompanyHandler],
  ['/api/check-link', checkLinkHandler],
  ['/api/jobs', jobsHandler],
]);

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

function findStaticRoot() {
  const candidates = [
    process.env.STATIC_DIR,
    path.resolve(__dirname, '..', '..', '..', 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fsSync.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

const STATIC_ROOT = findStaticRoot();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a request path inside STATIC_ROOT, or null when it would
 *  escape the root (path traversal). */
function staticPathFor(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const joined = path.normalize(path.join(STATIC_ROOT, decoded));
  if (joined !== STATIC_ROOT && !joined.startsWith(STATIC_ROOT + path.sep)) return null;
  return joined;
}

async function serveFile(nodeRes, filePath, { head = false } = {}) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    nodeRes.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    nodeRes.end(head ? undefined : data);
    return 200;
  } catch {
    return null;
  }
}

async function serveStatic(nodeReq, nodeRes, urlPath) {
  const head = nodeReq.method === 'HEAD';
  // GET / → index.html; any other path → the file, else SPA fallback.
  if (urlPath === '/' || urlPath === '') {
    const status = await serveFile(nodeRes, path.join(STATIC_ROOT, 'index.html'), { head });
    return status ?? 500;
  }
  const filePath = staticPathFor(urlPath);
  if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const status = await serveFile(nodeRes, filePath, { head });
        if (status !== null) return status;
      }
    } catch {
      // Falls through to the SPA fallback below.
    }
  }
  // SPA fallback: client-side routes (e.g. /finder) are index.html.
  const status = await serveFile(nodeRes, path.join(STATIC_ROOT, 'index.html'), { head });
  return status ?? 500;
}

/* ------------------------------------------------------------------ */
/* API adapter                                                         */
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
        allow: 'GET, HEAD, POST, PUT, OPTIONS',
        'content-length': '0',
      });
      nodeRes.end();
      status = 204;
    } else if (pathname === '/healthz') {
      sendJson(nodeRes, 200, { ok: true, render: 'disabled' });
      status = 200;
    } else if (pathname.startsWith('/api/')) {
      if (method === 'HEAD') {
        // Handlers speak GET/POST/PUT; a HEAD on an API route is a
        // client error, answered headers-only.
        nodeRes.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        nodeRes.end();
        status = 405;
      } else {
        status = await handleApi(nodeReq, nodeRes, url, pathname);
      }
    } else if (method === 'GET' || method === 'HEAD') {
      status = await serveStatic(nodeReq, nodeRes, pathname);
    } else {
      sendJson(nodeRes, 405, { error: 'method not allowed' });
      status = 405;
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
  console.log(`jobboard service listening on :${PORT} (static: ${STATIC_ROOT}, render: disabled)`);
});

// Cloud Run sends SIGTERM on scale-down / new revision: stop taking
// connections, then exit. In-flight find-jobs chunks get the grace
// period Cloud Run allows (default 10s) to finish.
server.on('error', (e) => {
  console.error('server error:', e);
  process.exit(1);
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
