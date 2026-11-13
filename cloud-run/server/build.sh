#!/usr/bin/env bash
# Bundle the Cloud Run service entry + api handlers into one file.
# Uses the project's own esbuild (via vite) — no new dependencies.
# Format is ESM (the project is "type": "module" and the entry uses
# import.meta.url): a CJS bundle breaks import.meta.url — esbuild
# warns "import.meta is not available with the cjs output format"
# and the static-root lookup would resolve against an empty path.
# mongodb, @sparticuz/chromium-min and puppeteer-core stay external:
# mongodb (like tests/finder.test.mjs does) because bundling it risks
# its optional native deps; the two browser packages because their
# dep tree (tar-fs → tar-stream → streamx → events-universal) does a
# dynamic require('events') that esbuild's ESM __require shim
# rejects at load time ("Dynamic require of events is not
# supported"). External, Node's real CJS loader handles them. They
# are still inert at runtime: nothing in the service ever calls the
# render path (see server.mjs header), so the loader is imported
# and never used. All three are installed from package.json in the
# runtime image.
#   Output: cloud-run/server/dist-server/server.mjs
#   Run from anywhere; safe to re-run (overwrites the bundle).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$ROOT/node_modules/.bin/esbuild" "$ROOT/cloud-run/server/server.mjs" \
  --bundle --platform=node --format=esm \
  --external:mongodb --external:@sparticuz/chromium-min --external:puppeteer-core \
  --outfile="$ROOT/cloud-run/server/dist-server/server.mjs"
echo "bundled -> $ROOT/cloud-run/server/dist-server/server.mjs"
