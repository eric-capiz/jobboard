#!/usr/bin/env bash
# Bundle the finder-runner entry + api handlers into one file.
# Mirror of cloud-run/server/build.sh (piece (a)) — same tool, same
# externals, same ESM format (the entry uses import.meta.url).
# mongodb, @sparticuz/chromium-min and puppeteer-core stay external:
# mongodb (like tests/finder.test.mjs does) because bundling it risks
# its optional native deps; the two browser packages because their
# dep tree (tar-fs → tar-stream → streamx → events-universal) does a
# dynamic require('events') that esbuild's ESM __require shim
# rejects at load time ("Dynamic require of events is not
# supported"). External, Node's real CJS loader handles them. All
# three are installed from package.json in the runtime image.
#   Output: cloud-run/runner/dist-server/server.mjs
#   Run from anywhere; safe to re-run (overwrites the bundle).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$ROOT/node_modules/.bin/esbuild" "$ROOT/cloud-run/runner/server.mjs" \
  --bundle --platform=node --format=esm \
  --external:mongodb --external:@sparticuz/chromium-min --external:puppeteer-core \
  --outfile="$ROOT/cloud-run/runner/dist-server/server.mjs"
echo "bundled -> $ROOT/cloud-run/runner/dist-server/server.mjs"
