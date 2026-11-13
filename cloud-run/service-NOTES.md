# JobBoard Cloud Run — UI/API service image: notes (piece 1 of 3)

Status: built and verified locally 2026-11-12 ~19:50 MST. Deployment is
a separate step (see `README.md` in this directory — zero-input is
absolute, so nothing here assumes Eric authenticates or sets anything
up; the deploy path runs wherever gcloud is already authenticated).

## Files written (this piece)

- `cloud-run/server/server.mjs` — Node http adapter (node:http + fs
  only, no new npm dependencies). Serves `dist/` + SPA fallback and
  routes `/api/*` to the matching `api/*.ts` default handlers.
- `cloud-run/server/build.sh` — esbuild bundle step → 
  `cloud-run/server/dist-server/server.mjs` (2.5 MB ESM bundle before
  externals were split out; 148.6 kB after — see "Bundle" below).
- `cloud-run/Dockerfile.service` — multi-stage image (build: full deps
  + `npm run build` + bundle; runtime: node:22-slim, prod deps only,
  `dist/` + bundled server, no Chromium).
- `cloud-run/service-NOTES.md` — this file.

No `package.json` scripts were added or edited. No files under `api/`
or `tests/` were changed.

## Adapter design

Each `api/*.ts` handler expects Vercel shapes
`(VercelRequest, VercelResponse)`:
`req = { method, headers, query?, body? }`,
`res = { status(code).json(body) }` (see `api/finder-lib.ts:24-32`;
`api/state.ts` redefines the same two interfaces locally). The adapter
translates a Node request into those shapes:

- **Headers**: passed through as-is — Node already lowercases them,
  and the value type (`string | string[] | undefined`) matches.
- **Query**: `URLSearchParams` folded into
  `Record<string, string | string[]>`; a repeated key becomes an
  array, matching Vercel semantics. `api/finder-lib.ts:40-44`
  (`firstQuery`) takes the first element, so `/api/companies` paging
  works unchanged.
- **Body**: streamed and JSON-parsed when the content type is JSON.
  Empty body → `undefined` (handlers already do `req.body ?? {}`).
  Bad JSON → 400 `{error:'invalid JSON body'}`; bodies over 10 MB →
  413 (the state PUT is ~4.5 MB, so 10 MB leaves headroom).
- **Response**: `status(code).json(body)` writes one JSON response
  with `cache-control: no-store`; a double-send guard keeps only the
  first answer. Handler throws are caught → 500 `{error: msg}`.
- **Static**: `dist/` served with content types + long cache for
  hashed assets, `no-cache` for HTML. Unknown non-`/api` paths fall
  back to `dist/index.html` (SPA routing). Static root resolves in
  order: `$STATIC_DIR`, `../../../dist` from the bundle, `./dist`
  under cwd. Traversal outside the root is rejected.
- **HEAD/OPTIONS**: OPTIONS → 204 with an `Allow` header. HEAD on
  static paths serves headers only; HEAD on `/api/*` → 405
  (handlers speak GET/POST/PUT).
- **Health**: `GET /healthz` → `{"ok":true,"render":"disabled"}`.
- **Port**: `$PORT`, default 8080. SIGTERM closes the server (Cloud
  Run scale-down). One access-log line per request on stdout.

### Routes

| Path | Handler |
|---|---|
| `/api/state` | `api/state.ts` |
| `/api/companies` | `api/companies.ts` |
| `/api/companies/import` | `api/companies/import.ts` |
| `/api/companies/migrate` | `api/companies/migrate.ts` |
| `/api/find-companies` | `api/find-companies.ts` |
| `/api/find-jobs` | `api/find-jobs.ts` |
| `/api/test-company` | `api/test-company.ts` |

`/api/companies/import` and `/api/companies/migrate` are routed even
though the brief listed five endpoints: the UI calls both
(`src/store/index.tsx:357,423`, `src/components/FinderView.tsx:488`),
so Vercel parity requires them. They take the same adapter path as
the other five — no special handling. Unknown `/api/*` → 404 JSON.

## How rendering is disabled (no api/ or tests/ change needed)

Three layers, all verified:

1. **`server.mjs` forces `process.env.JOBBOARD_NO_RENDER = '1'` at
   startup**, before any request is handled, overriding any inherited
   env. A service that must never render must not depend on whoever
   launched it remembering a flag.
2. **`Dockerfile.service` sets `ENV JOBBOARD_NO_RENDER=1`** as well.
3. **The leaf already existed**: `api/render-page.ts`
   `renderDisabled()` reads the flag inside `renderPageHtml()` on
   every call and returns `null` immediately when it is `'1'` — before
   `getBrowser()`, the only place that downloads/launches Chromium
   (`chromium.executablePath()`), is ever reached. The
   `@sparticuz/chromium-min` import is load-time inert: its only
   module-load side effect is an Amazon-Linux-2023 env setup that
   does not trigger outside that platform, and the ~70 MB Chromium
   download happens only inside `executablePath()`.

With the flag on, a render call is a ~0 ms `null`:
`api/find-jobs.ts:2117-2200` records it as a `render-null` attempt
(fast-fail → one free retry on the same target, then moves on) and
`api/test-company.ts:207-222` probe mode answers `render-null` with
no markup. The offline suite already covers this path:
`tests/finder.test.mjs:23` sets `JOBBOARD_NO_RENDER=1` and
`~line 5488-5500` asserts probe → `render-null`. No code change was
needed, so none was made — that is the evidence, not an assumption.

The service therefore runs the plain-HTML path only. Rendering
belongs to the finder runner image (piece 2/3).

## Bundle

`cloud-run/server/build.sh` runs the project's own esbuild (via
vite) — no new dependencies:

```
esbuild cloud-run/server/server.mjs --bundle --platform=node \
  --format=esm --external:mongodb \
  --external:@sparticuz/chromium-min --external:puppeteer-core \
  --outfile=cloud-run/server/dist-server/server.mjs
```

- **ESM, not CJS.** The project is `"type": "module"` and the entry
  uses `import.meta.url` for the static root. A first CJS attempt
  failed review: esbuild warns `import.meta is not available with
  the "cjs" output format` and the emitted `__dirname` resolves
  against an empty URL. ESM keeps `import.meta.url` native.
- **Three externals.** `mongodb` stays external (same precedent as
  `tests/finder.test.mjs`, which bundles with `--external:mongodb`)
  and is installed from `package.json` in the runtime image.
  `@sparticuz/chromium-min` and `puppeteer-core` are external for a
  different reason, found by running the first ESM bundle: their dep
  tree (`tar-fs → tar-stream → streamx → events-universal`) does a
  dynamic `require('events')` that esbuild's ESM `__require` shim
  rejects at load time (`Error: Dynamic require of "events" is not
  supported`). External, Node's real CJS loader handles them. They
  are still inert at runtime (see above) — imported, never used.
  Result: bundle shrank 2.5 MB → 148.6 kB; the three externals
  resolve from `node_modules` at runtime (stage 2 installs prod
  deps).
- `api/*.ts` are **not typechecked** by `npm run build`
  (`tsconfig.json` includes only `src/`); esbuild catches syntax
  errors at bundle time, not type errors. Pre-existing behavior,
  unchanged here.

## Dockerfile.service

Build context is the repo root. Files are copied selectively (no
`.dockerignore` needed): the local `node_modules/` and the sweep
archives never enter the context.

- **Stage 1 (`node:22-slim`, full deps):** `npm ci`, copy
  `index.html`, `vite.config.ts`, `tailwind.config.js`,
  `postcss.config.js`, `tsconfig.json`, `src/`, `api/`,
  `cloud-run/`; `ARG VITE_SYNC_KEY` → `ENV VITE_SYNC_KEY` so the
  browser bundle can authenticate to `/api/*` (without it the SPA
  builds but sync no-ops, per `src/sync.ts:3`); `npm run build`;
  `./cloud-run/server/build.sh`.
- **Stage 2 (`node:22-slim`, prod deps only):** `npm ci --omit=dev`,
  copy `dist/` + `dist-server/`, `USER node`, `EXPOSE 8080`,
  `CMD ["node", "cloud-run/server/dist-server/server.mjs"]`.
  No Chromium, no build tools.
- `VITE_SYNC_KEY` is a **build-time** arg (baked into the browser
  bundle); `MONGODB_URI` / `SYNC_KEY` are **runtime** env vars and
  must never be baked into the image. Deploy command and secret
  plumbing live in `deploy-service.sh` / `set-env.sh` (sibling
  pieces); the deploy itself runs wherever gcloud is already
  authenticated — no setup step by Eric is assumed.

## What was verified (exact commands + results)

All run 2026-11-12 ~19:48–19:52 MST from `~/workspace/jobboard`.
Node on this VM is v24.22.1; the image pins node:22-slim per the
repo's `engines: node 22.x`.

1. **`npm run build`** (tsc --noEmit + vite build) — PASS.
   `✓ built in 13.28s`. (Pre-existing chunk-size warning about
   >500 kB chunks; unchanged.)
2. **`node tests/finder.test.mjs`** — PASS: **392 passed, 0 failed**
   (matches the stated 392/0 baseline). Took ~136 s.
3. **Bundle**: `./cloud-run/server/build.sh` — PASS, no warnings.
   `cloud-run/server/dist-server/server.mjs`, 148.6 kB,
   `node --check` clean. Externals confirmed as live ESM imports
   (`import ... from "mongodb"`, `"@sparticuz/chromium-min"`,
   `"puppeteer-core"`).
4. **Local server run** (SYNC_KEY read from
   `~/workspace/dealboard-ops/jobboard-sync-key.txt` into a shell
   variable — value never printed; `MONGODB_URI` unset; `PORT=18099`;
   `node cloud-run/server/dist-server/server.mjs`):
   startup line: `jobboard service listening on :18099 (static:
   /home/hatch/workspace/jobboard/dist, render: disabled)`

   | Check | Result |
   |---|---|
   | `GET /api/state` with `x-sync-key` | **500 `{"error":"MONGODB_URI not set"}`** — auth passed, wiring reached the handler, DB correctly absent |
   | `GET /api/state` without key | **401 `{"error":"unauthorized"}`** |
   | `GET /api/companies?skip=0&limit=25` without key | **401 `{"error":"unauthorized"}`** |
   | `GET /` | **200**, SPA `index.html` (`<!doctype html>`, `JobBoard` title) |
   | `GET /finder` (unknown client route) | **200**, SPA fallback `index.html`, `<title>JobBoard</title>` |
   | `OPTIONS /api/state` | **204** |
   | `HEAD /` | **200**, headers only |
   | `POST /api/test-company` probe, key, fake company `https://example.invalid` | **200 `{"probe":true,"renderError":"render-null","markup":null,...}` in 3 ms** — render disabled end-to-end through the real handler; the `.invalid` URL was never fetched |
   | `POST /api/test-company` without key | **401** |
   | `POST /api/state` with bad JSON body | **400 `{"error":"invalid JSON body"}`** |
   | `GET /healthz` | **200 `{"ok":true,"render":"disabled"}`** |

   Server log confirmed one line per request with the expected
   statuses. No live board writes, no employer-site fetches, no
   sweeps. Test server stopped after the checks.

## What was NOT verified locally

- **Actual `docker build`** — Docker is not installed on this VM
  (no docker/podman/gcloud). The Dockerfile was validated by
  review only: stage-1 file set matches what `npm run build` +
  `build.sh` need (verified by running both locally), stage-2
  copy paths match the build outputs, `node:22-slim` matches
  `engines`. First real build happens in GCP via
  `gcloud run deploy --source` (Cloud Build).
- **A run with `MONGODB_URI` set** — deliberately not done: that
  would touch the live board. The 500/`MONGODB_URI not set` result
  is the intended no-DB proof of auth + wiring.
- **Node 22 runtime behavior** — verified under Node v24 on this
  VM; the image uses node:22-slim. The code uses no Node-23/24-only
  APIs (`node:http`, `node:fs`, `URL`, top-level `import.meta` all
  predate Node 22).
- **`/api/find-jobs` / `/api/find-companies` happy paths** — not
  callable without a DB and (for find-jobs) without fetching employer
  pages; both are forbidden in local verification. Their handler
  wiring is identical to `/api/state` (same adapter, same route
  table) and their code paths are covered by the 392-test suite.
- **`VITE_SYNC_KEY` baked build** — the local `npm run build` ran
  without the key, so the rebuilt `dist/` has sync no-op'd in the
  browser bundle (per `src/sync.ts`). That only affects browser
  behavior, not the server checks above; the real key is supplied
  as a build arg at deploy time by `deploy-service.sh`.

## Open items / flags for the coordinator

- **No `api/` or `tests/` changes** — nothing to review there.
  The only judgment call was routing `/api/companies/import` and
  `/api/companies/migrate` in addition to the five listed endpoints
  (UI calls them; see Routes above).
- **Bundle-format lesson (for the runner piece):** if the finder
  runner bundles with esbuild too, use ESM output and externalize
  `@sparticuz/chromium-min`/`puppeteer-core` (dynamic `require`
  breaks under esbuild's ESM shim) — or bundle CJS and avoid
  `import.meta.url` entirely.
- **`dist/` was rebuilt** by the local `npm run build` (no
  `VITE_SYNC_KEY` in the environment, so the browser bundle in
  `dist/` currently has sync disabled). The deploy build redoes
  this with the key as a build arg; do not treat the local `dist/`
  as deployable as-is.
- **Deploy is blocked on zero-input** (see `README.md`): no GCP
  project, billing, or credentials exist on this VM, and Eric
  will not set any up. This piece is complete and ready for the
  day that changes.
