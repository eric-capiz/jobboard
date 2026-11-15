/* Finder server-core tests — mocked inputs only.
 *
 * No real MongoDB, no real network, no writes to any user database.
 * The handler bundles are built with esbuild (--external:mongodb) and
 * the 'mongodb' import is intercepted with an in-memory fake; global
 * fetch is stubbed with canned public-source responses.
 *
 * Run: node tests/finder.test.mjs   (from ~/workspace/jobboard)
 * Requires: ./node_modules/.bin/esbuild (already a project dependency)
 */

import { execSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// The render fallback needs a real browser — never in this suite: the
// stubbed fetch has no real pages behind it, and a launch would try to
// download Chromium. Tests covering the fallback inject a stub renderer
// through runFindJobs opts instead.
process.env.JOBBOARD_NO_RENDER = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = '/tmp/finder-test-bundles';
execSync(`mkdir -p ${OUT}`);
for (const name of ['find-companies', 'find-jobs', 'finder-lib', 'test-company', 'render-search']) {
  execSync(
    `${ROOT}/node_modules/.bin/esbuild ${ROOT}/api/${name}.ts --bundle --platform=node --format=cjs --external:mongodb --outfile=${OUT}/${name}.cjs`,
    { stdio: 'pipe' },
  );
}

/* ------------------------------------------------------------------ */
/* In-memory MongoDB fake (supports exactly the operators the code uses) */
/* ------------------------------------------------------------------ */

function getDotted(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}
function setDotted(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function matches(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some((c) => matches(doc, c))) return false;
      continue;
    }
    const val = getDotted(doc, key);
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) {
        if (!cond.$in.includes(val)) return false;
        continue;
      }
      if ('$regex' in cond) {
        const re = new RegExp(cond.$regex, cond.$options ?? '');
        if (typeof val !== 'string' || !re.test(val)) return false;
        continue;
      }
    }
    if (val !== cond) return false;
  }
  return true;
}

class FakeCursor {
  constructor(docs) {
    this.docs = docs;
  }
  project(spec) {
    const keys = Object.keys(spec).filter((k) => spec[k]);
    this.docs = this.docs.map((d) => {
      const out = {};
      for (const k of keys) if (k in d) out[k] = d[k];
      if ('_id' in d) out._id = d._id;
      return out;
    });
    return this;
  }
  sort(spec) {
    const [[key, dir]] = Object.entries(spec);
    this.docs = [...this.docs].sort((a, b) => {
      const av = getDotted(a, key);
      const bv = getDotted(b, key);
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return (av < bv ? -1 : 1) * dir;
    });
    return this;
  }
  skip(n) {
    this.docs = this.docs.slice(n);
    return this;
  }
  limit(n) {
    this.docs = this.docs.slice(0, n);
    return this;
  }
  async toArray() {
    return this.docs;
  }
}

class FakeCollection {
  constructor() {
    this.docs = [];
    this.nextId = 1;
  }
  find(filter) {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)));
  }
  async countDocuments(filter) {
    return this.docs.filter((d) => matches(d, filter ?? {})).length;
  }
  async findOne(filter) {
    return this.docs.find((d) => matches(d, filter)) ?? null;
  }
  async updateOne(filter, update, options) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (doc) {
      // Mirror Mongo's sparse compound unique on (domain, nameKey):
      // an update that would land on another doc's pair throws E11000,
      // exactly like production (this caught the 2026-11-03 upgrade
      // collision that bricked Find Companies).
      const next = { ...doc };
      for (const [k, v] of Object.entries(update.$set ?? {})) setDotted(next, k, v);
      if (typeof next.nameKey === 'string') {
        const clash = this.docs.some(
          (d) =>
            d !== doc &&
            (d.domain ?? '') === (next.domain ?? '') &&
            d.nameKey === next.nameKey &&
            (next.domain !== undefined || d.domain === undefined),
        );
        if (clash) {
          const err = new Error('E11000 duplicate key');
          err.code = 11000;
          throw err;
        }
      }
      for (const [k, v] of Object.entries(update.$set ?? {})) setDotted(doc, k, v);
      return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
    }
    if (options?.upsert) {
      const created = { _id: filter._id ?? this.nextId++ };
      for (const [k, v] of Object.entries(update.$set ?? {})) setDotted(created, k, v);
      this.docs.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
  }
  async insertMany(docs, options) {
    const writeErrors = [];
    let insertedCount = 0;
    for (const doc of docs) {
      const dup = this.docs.some(
        (d) =>
          (d.domain ?? '') === (doc.domain ?? '') &&
          d.nameKey === doc.nameKey &&
          // Sparse compound unique: a doc without a domain collides only
          // with another doc without a domain on the same nameKey; a doc
          // WITH a domain collides only when both match.
          (doc.domain !== undefined || d.domain === undefined),
      );
      if (dup) {
        writeErrors.push({ code: 11000 });
        if (options?.ordered !== false) break;
        continue;
      }
      this.docs.push({ ...doc, _id: this.nextId++ });
      insertedCount += 1;
    }
    if (writeErrors.length > 0) {
      const err = new Error('E11000 duplicate key');
      err.writeErrors = writeErrors;
      err.result = { insertedCount };
      throw err;
    }
    return { insertedCount };
  }
  async createIndex() {
    return 'fake-index';
  }
}

class FakeDb {
  constructor() {
    this.cols = {};
  }
  collection(name) {
    if (!this.cols[name]) this.cols[name] = new FakeCollection();
    return this.cols[name];
  }
}

class FakeMongoClient {
  constructor() {
    this.dbs = {};
  }
  async connect() {
    return this;
  }
  db(name) {
    if (!this.dbs[name]) this.dbs[name] = new FakeDb();
    return this.dbs[name];
  }
}

// Intercept 'mongodb' for the handler bundles (they were built external).
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'mongodb') return { MongoClient: FakeMongoClient };
  return origLoad.call(this, request, ...args);
};

function freshRequire(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}
function mkRes() {
  const res = { statusCode: 0, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return { json: (body) => (res.body = body) };
  };
  return res;
}
function mkReq(method, body, headers = {}) {
  return { method, headers, query: {}, body };
}

/* ------------------------------------------------------------------ */
/* Canned public-source responses (no network)                         */
/* ------------------------------------------------------------------ */

function wdqsBindingsPage1() {
  // 300 bindings collapsing to 90 entities (60 x 4 websites + 30 x 2).
  const bindings = [];
  for (let e = 1; e <= 60; e++) {
    for (const site of [
      `https://comp${e}.example/uk/page`,
      `https://www.comp${e}.example/about`,
      `https://comp${e}.example`,
      `https://comp${e}.example/de`,
    ]) {
      bindings.push({
        company: { value: `http://www.wikidata.org/entity/Q${1000 + e}` },
        companyLabel: { value: `Company ${e}` },
        website: { value: site },
      });
    }
  }
  for (let e = 61; e <= 90; e++) {
    for (const site of [`https://comp${e}.example/path`, `https://comp${e}.example`]) {
      bindings.push({
        company: { value: `http://www.wikidata.org/entity/Q${1000 + e}` },
        companyLabel: { value: `Company ${e}` },
        website: { value: site },
      });
    }
  }
  return bindings;
}
function wdqsBindingsPage2() {
  // 3 brand-new entities + 2 bindings of press-1 entities (dupes).
  return [
    { company: { value: 'http://www.wikidata.org/entity/Q2001' }, companyLabel: { value: 'NewCo A' }, website: { value: 'https://newcoa.example' } },
    { company: { value: 'http://www.wikidata.org/entity/Q2002' }, companyLabel: { value: 'NewCo B' }, website: { value: 'https://newcob.example' } },
    { company: { value: 'http://www.wikidata.org/entity/Q2003' }, companyLabel: { value: 'NewCo C' }, website: { value: 'https://newcoc.example' } },
    { company: { value: 'http://www.wikidata.org/entity/Q1001' }, companyLabel: { value: 'Company 1' }, website: { value: 'https://comp1.example' } },
    { company: { value: 'http://www.wikidata.org/entity/Q1002' }, companyLabel: { value: 'Company 2' }, website: { value: 'https://comp2.example' } },
  ];
}
function wdqsFetchFactory(pages) {
  // Pages are consumed in order; once exhausted, further calls return an
  // empty page (the source is out of rows) — never repeat a page.
  let calls = 0;
  const fn = async (url) => {
    if (!String(url).includes('query.wikidata.org')) throw new Error('unexpected URL ' + url);
    const page = pages[calls] ?? [];
    calls += 1;
    return { ok: true, json: async () => ({ results: { bindings: page } }) };
  };
  fn.calls = () => calls;
  return fn;
}

/* Route fetch calls by URL: WDQS pages, the SEC ticker map, and SEC
 * submissions. The default EDGAR map is empty (EDGAR exhausts at once),
 * so older Wikidata-only tests keep their expectations. */
function routeFetch(wdqsFactory, edgarMap, edgarSubs) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('query.wikidata.org')) return wdqsFactory(u, init);
    if (u.includes('company_tickers.json')) {
      return { ok: true, json: async () => edgarMap };
    }
    if (u.includes('/submissions/CIK')) {
      if (!edgarSubs) throw new Error('unexpected submissions fetch');
      return edgarSubs(u, init);
    }
    throw new Error('unexpected URL ' + u);
  };
}

function boardsFetchStub(url) {
  const u = String(url);
  if (u.includes('boards-api.greenhouse.io')) {
    return Promise.resolve({
      ok: true,
      text: async () =>
        JSON.stringify({
          jobs: [
            {
              title: 'Frontend Engineer',
              location: { name: 'Remote US' },
              absolute_url: 'https://job-boards.greenhouse.io/testcorp/jobs/1',
              content: '<p>We need a React TypeScript JavaScript frontend developer with Storybook and design systems experience.</p>',
              created_at: '2026-10-20T00:00:00Z',
            },
            {
              title: 'Backend Engineer',
              location: { name: 'Remote US' },
              absolute_url: 'https://job-boards.greenhouse.io/testcorp/jobs/2',
              content: '<p>Go services.</p>',
              created_at: '2026-10-20T00:00:00Z',
            },
          ],
        }),
    });
  }
  // Board-discovery fetches: pages with no board links.
  return Promise.resolve({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  }
}

process.env.MONGODB_URI = 'mongodb://fake-test';
process.env.SYNC_KEY = 'testkey';

async function testFindCompanies() {
  const mod = freshRequire(`${OUT}/find-companies.cjs`);
  const handler = mod.default;
  // One shared factory across presses: press 1 consumes page 1 (limit 90
  // stops the press before page 2), press 2 consumes page 2 + empty.
  const factory = wdqsFetchFactory([wdqsBindingsPage1(), wdqsBindingsPage2()]);
  globalThis.fetch = routeFetch(factory, {}, null);
  let res = mkRes();
  await handler(mkReq('POST', { limit: 90 }, { 'x-sync-key': 'testkey' }), res);
  check('find-companies press 1 status 200', res.statusCode === 200, res);
  check('find-companies press 1 added 90', res.body?.added === 90, res.body);
  check('find-companies press 1 not exhausted (limit stopped it)', res.body?.exhausted === false, res.body);
  check('find-companies press 1 source label', res.body?.source === 'Wikidata social', res.body);
  // Press 2 (same module instance = same fake DB + cursor): page 2 gives
  // 3 new (2 dupes filtered), then the empty page exhausts the source.
  res = mkRes();
  await handler(mkReq('POST', { limit: 2000 }, { 'x-sync-key': 'testkey' }), res);
  check('find-companies press 2 added 3 (dupes filtered)', res.body?.added === 3, res.body);
  check('find-companies press 2 exhausted', res.body?.exhausted === true, res.body);
  check('find-companies press 2 total 93', res.body?.total === 93, res.body);
  // Press 3: nothing left, no error.
  res = mkRes();
  await handler(mkReq('POST', { limit: 2000 }, { 'x-sync-key': 'testkey' }), res);
  check('find-companies press 3 added 0, exhausted, no error', res.body?.added === 0 && res.body?.exhausted === true && !res.body?.error, res.body);
  // Auth failure.
  res = mkRes();
  await handler(mkReq('POST', { limit: 2000 }, { 'x-sync-key': 'wrong' }), res);
  check('find-companies wrong key 401', res.statusCode === 401, res);
  // Cursor + best-website check via the core with explicit fakes.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  globalThis.fetch = routeFetch(wdqsFetchFactory([wdqsBindingsPage1(), wdqsBindingsPage2()]), {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('find-companies core full walk added 93', out.added === 93, out);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check(
    'find-companies core cursor past all sources (social + per-type wikidata + empty edgar + organization + keyset + types + business keyset)',
    cursorDoc?.sourceIndex === 8 &&
      cursorDoc?.state?.['wikidata-social']?.comboIndex === 24 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-social']?.offsets?.slice(0, 1)) === JSON.stringify([600]) &&
      cursorDoc?.state?.wikidata?.typeIndex === 4 &&
      JSON.stringify(cursorDoc?.state?.wikidata?.offsets) === JSON.stringify([300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-social-organization']?.comboIndex === 6 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-social-organization']?.offsets) === JSON.stringify([300, 300, 300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-organization']?.offset === 300 &&
      cursorDoc?.state?.['wikidata-organization-keyset']?.lastIri === '' &&
      cursorDoc?.state?.['wikidata-types-keyset']?.typeIndex === 17 &&
      cursorDoc?.state?.['wikidata-business-keyset']?.typeIndex === 4,
    cursorDoc,
  );
  const comp1 = (await companiesCol.find({ name: 'Company 1' }).toArray())[0];
  check('find-companies best website wins (root .com)', comp1?.website === 'https://comp1.example', comp1);
}

async function testFindCompaniesTransientError() {
  const mod = freshRequire(`${OUT}/find-companies.cjs`);
  const handler = mod.default;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const res = mkRes();
  await handler(mkReq('POST', { limit: 2000 }, { 'x-sync-key': 'testkey' }), res);
  check('find-companies transient error: added 0 + retry message', res.body?.added === 0 && typeof res.body?.error === 'string', res.body);
  // Retry with a good page: cursor must NOT have advanced (offset still
  // 0), so the retry returns page 1's companies.
  globalThis.fetch = wdqsFetchFactory([wdqsBindingsPage1()]);
  const res2 = mkRes();
  await handler(mkReq('POST', { limit: 2000 }, { 'x-sync-key': 'testkey' }), res2);
  check('find-companies retry after error returns page 1 (90)', res2.body?.added === 90, res2.body);
}

async function testFindCompaniesDupeStretch() {
  // Press once (limit 90: consumes page 1 only, cursor at offset 300),
  // rewind the cursor to 0, press again: the walk yields only dupes, so
  // the press returns 0 with a NOTE (not an error) and the cursor still
  // advances past the page — the button never gets stuck on a dupe
  // stretch.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  globalThis.fetch = wdqsFetchFactory([wdqsBindingsPage1()]);
  const first = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 90 },
  );
  check('dupe-stretch setup press added 90', first.added === 90, first);
  // Rewind the social adapter's first combo to 0 (the press starts at
  // social now, so the re-press re-consumes page 1 through social).
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { 'state.wikidata-social.offsets': [0], 'state.wikidata-social.comboIndex': 0 } },
    {},
  );
  globalThis.fetch = routeFetch(wdqsFetchFactory([wdqsBindingsPage1()]), {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('dupe-stretch press: added 0 with note, no error', out.added === 0 && typeof out.note === 'string' && !out.error, out);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  // The re-press consumed page 1 (all dupes) and then empty follow-up
  // pages through every combo, type, and source — the cursor advanced
  // past all consumed work, so the button is never stuck.
  check(
    'dupe-stretch press: cursor advanced past consumed pages',
    JSON.stringify(cursorDoc?.state?.['wikidata-social']?.offsets?.slice(0, 1)) === JSON.stringify([600]) &&
      JSON.stringify(cursorDoc?.state?.wikidata?.offsets) === JSON.stringify([300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-social-organization']?.comboIndex === 6 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-social-organization']?.offsets) === JSON.stringify([300, 300, 300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-organization']?.offset === 300 &&
      cursorDoc?.state?.['wikidata-organization-keyset']?.lastIri === '' &&
      cursorDoc?.state?.['wikidata-types-keyset']?.typeIndex === 17 &&
      cursorDoc?.state?.['wikidata-business-keyset']?.typeIndex === 4 &&
      cursorDoc?.sourceIndex === 8,
    cursorDoc,
  );
}

async function testFindJobs() {
  const mod = freshRequire(`${OUT}/find-jobs.cjs`);
  const handler = mod.default;
  // Seed the fake DB through the handler's own collection: use the
  // lib-free path — press find-companies first? No: seed via a first
  // find-jobs call is impossible. Instead use runFindJobs directly with
  // a hand-built fake collection.
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'PageCo', website: 'https://pageco.example', domain: 'pageco.example', nameKey: 'pageco', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'NoSource Inc', website: 'https://nosource.example', domain: 'nosource.example', nameKey: 'nosource inc', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  const rawHtml = `<html><body>
<div class="job-listing"><h3>Frontend Developer</h3><p>Location: Remote</p><a href="/jobs/frontend-developer">Apply</a></div>
<div class="job-listing"><h3>Loan Analyst</h3><p>Location: Remote</p><a href="/jobs/loan-analyst">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://pageco.example/careers') {
      return { ok: true, text: async () => rawHtml };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const out = await mod.runFindJobs(
    { companiesCol },
    { resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience', cursor: 0, limit: 15 },
  );
  check('find-jobs leads 1 (loan filtered)', out.leads.length === 1, out);
  check('find-jobs lead is Frontend Developer @ PageCo, score 63', out.leads[0]?.title === 'Frontend Developer' && out.leads[0]?.company === 'PageCo' && out.leads[0]?.matchScore === 63, out.leads[0]);
  check('find-jobs checked 2, total 2, done', out.checked === 2 && out.totalCompanies === 2 && out.done === true && out.nextCursor === null, out);
  check('find-jobs stats', out.stats.postingsSeen === 2 && out.stats.noBoard === 1 && out.stats.boardErrors === 0, out.stats);
  // Paging: limit 1.
  const page = await mod.runFindJobs({ companiesCol }, { resumeText: 'React', cursor: 0, limit: 1 });
  check('find-jobs paging limit 1', page.checked === 1 && page.totalCompanies === 2 && page.nextCursor === 1 && page.done === false, page);
  // Handler-level auth check.
  const res = mkRes();
  await handler(mkReq('POST', {}, { 'x-sync-key': 'wrong' }), res);
  check('find-jobs wrong key 401', res.statusCode === 401, res);
}

async function testFindJobsNonFrontend() {
  // Resume-driven, not frontend-forced: a support resume must find a
  // support role and must NOT surface a frontend role.
  const mod = freshRequire(`${OUT}/find-jobs.cjs`);
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'SupportCo', website: 'https://supportco.example', domain: 'supportco.example', nameKey: 'supportco', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://supportco.example/careers') {
      return {
        ok: true,
        text: async () => `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div>
<div class="job-listing"><h3>Frontend Engineer</h3><p>Location: Remote</p><a href="/jobs/frontend-engineer">Apply</a></div>
</body></html>`,
      };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const out = await mod.runFindJobs(
    { companiesCol },
    { resumeText: 'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers', cursor: 0, limit: 15 },
  );
  check('find-jobs non-frontend: support lead found, frontend not surfaced', out.leads.length === 1 && out.leads[0]?.title === 'Customer Support Specialist', out.leads);
  // 71, not the old 69: plural stemming merges the resume's 'customer' /
  // 'customers' into one term, so the signature tightens from 8 terms
  // to 7 and the same 3 matches score higher (50 + 50*3/7 = 71).
  check('find-jobs non-frontend: support lead scores 71', out.leads[0]?.matchScore === 71, out.leads[0]);
}

async function testRenderFallback() {
  // The render fallback: a careers page whose static HTML is a bare
  // JS shell (zero listings) gets rendered in a real browser; the
  // rendered DOM is parsed with the same extractors. The renderer is
  // a stub here — the real browser never runs in this suite.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'JsBoard Co', website: 'https://jsboard.example', domain: 'jsboard.example', nameKey: 'jsboard co', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'Static Co', website: 'https://staticco.example', domain: 'staticco.example', nameKey: 'static co', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  const resumeText =
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const shellHtml = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
  const renderedHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div>
</body></html>`;
  const staticHtml = renderedHtml;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://staticco.example/careers') return { ok: true, text: async () => staticHtml };
    return { ok: true, text: async () => shellHtml };
  };
  const renderedUrls = [];
  const stubRender = async (url) => {
    renderedUrls.push(url);
    return { html: renderedHtml, searchOutcome: 'searched', searchMs: 250, renderedUrl: url };
  };
  const out = await jobsMod.runFindJobs(
    { companiesCol },
    { resumeText, cursor: 0, limit: 15 },
    { renderPage: stubRender },
  );
  check(
    'render: JS-shell careers page yields a lead through the fallback',
    out.leads.length === 2 && out.stats.postingsSeen === 2,
    out,
  );
  check(
    'render: rendered lead is stamped sourceType rendered, static lead stays html',
    out.leads.some((l) => l.company === 'JsBoard Co' && l.sourceType === 'rendered') &&
      out.leads.some((l) => l.company === 'Static Co' && l.sourceType === 'html'),
    out.leads,
  );
  check('render: stats.rendered counts the rendered company', out.stats.rendered === 1, out.stats);
  check(
    'render: only the careers URL renders, never the homepage',
    renderedUrls.length === 1 && renderedUrls[0] === 'https://jsboard.example/careers',
    renderedUrls,
  );
  // A failed render leaves the company at zero listings, unchanged.
  const failOut = await jobsMod.runFindJobs(
    { companiesCol },
    { resumeText, cursor: 0, limit: 15 },
    { renderPage: async () => null },
  );
  check(
    'render: failed render leaves noBoard/noListings counts unchanged',
    failOut.stats.noBoard === 1 && failOut.stats.noListings === 1 && failOut.stats.postingsSeen === 1,
    failOut.stats,
  );
  check(
    'render: no renderer passed means no render at all',
    (await jobsMod.runFindJobs({ companiesCol }, { resumeText, cursor: 0, limit: 15 })).stats.noBoard === 1,
    failOut.stats,
  );
  // The result carries the visible text the render saw, for
  // diagnosing a zero-listing render (bot challenge, empty search
  // state, or titles the extractors missed).
  const one = await jobsMod.searchCompanyJobs(
    { name: 'JsBoard Co', website: 'https://jsboard.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubRender },
  );
  check(
    'render: result carries the visible text the render saw',
    one.renderTextSample.includes('Customer Support Specialist') &&
      one.renderTextSample.length > 0 &&
      one.renderTextSample.length <= 300 &&
      !one.renderTextSample.includes('<'),
    one.renderTextSample,
  );
  check(
    'render: result surfaces the search outcome + ms + final URL',
    one.searchOutcome === 'searched' && one.searchMs === 250 && one.renderedUrl === 'https://jsboard.example/careers',
    { searchOutcome: one.searchOutcome, searchMs: one.searchMs, renderedUrl: one.renderedUrl },
  );
  // A render that fails before the search step leaves the outcome
  // null, not a stale value from another company.
  const failOne = await jobsMod.searchCompanyJobs(
    { name: 'JsBoard Co', website: 'https://jsboard.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: async () => null },
  );
  check(
    'render: failed render leaves searchOutcome null + zero ms + empty URL',
    failOne.searchOutcome === null && failOne.searchMs === 0 && failOne.renderedUrl === '',
    { searchOutcome: failOne.searchOutcome, searchMs: failOne.searchMs, renderedUrl: failOne.renderedUrl },
  );
  check(
    'render: no render means an empty text sample',
    (
      await jobsMod.searchCompanyJobs(
        { name: 'Static Co', website: 'https://staticco.example', careersUrl: '', isUSCompany: true },
        resumeText,
        { renderPage: stubRender },
      )
    ).renderTextSample === '',
    null,
  );
}

async function testTestCompany() {
  // Single-company test: same business-site search + resume matching
  // as the full sweep, for one company, with no database writes.
  const mod = freshRequire(`${OUT}/test-company.cjs`);
  const handler = mod.default;
  const rawHtml = `<html><body>
<div class="job-listing"><h3>Frontend Developer</h3><p>Location: Remote</p><a href="/jobs/frontend-developer">Apply</a></div>
<div class="job-listing"><h3>Loan Analyst</h3><p>Location: Remote</p><a href="/jobs/loan-analyst">Apply</a></div>
</body></html>`;
  // Careers page given directly: listings parsed off the business page.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://pageco.example/careers') {
      return { ok: true, text: async () => rawHtml };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res = mkRes();
  await handler(
    mkReq('POST', {
      company: { name: 'PageCo', website: '', careersUrl: 'https://pageco.example/careers' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res,
  );
  check('test-company: source is the given careers page', res.body?.sourcePage === 'https://pageco.example/careers', res.body);
  check('test-company: 1 matching lead, score 63', res.body?.leads?.length === 1 && res.body?.leads[0]?.matchScore === 63, res.body?.leads);
  check('test-company: postings seen 2', res.body?.postingsSeen === 2, res.body);
  check(
    'test-company: response carries the search-outcome fields (null when no render ran)',
    res.body?.searchOutcome === null && res.body?.searchMs === 0 && res.body?.renderedUrl === '',
    { searchOutcome: res.body?.searchOutcome, searchMs: res.body?.searchMs, renderedUrl: res.body?.renderedUrl },
  );
  // Widget on the careers page, found from the homepage nav
  // (Goldschmitt flow): the widget is part of the business page.
  const widgetJs = `<div id="resumator-job-job_20261027144142_FGDHFERUIMWO9F2B" class="resumator-job resumator-jobs-text"><div class="resumator-job-title resumator-jobs-text">Frontend Developer</div><div class="resumator-job-info resumator-jobs-text"><span class="resumator-job-location resumator-job-heading resumator-jobs-text">Location: </span>Remote<span class="resumator-job-department resumator-job-heading resumator-jobs-text">Department: </span>Timeguard Solutions</div><div class="resumator-job-view-details resumator-jobs-text"><a class="resumator-job-link resumator-jobs-text" target="_blank" href="https://testco.applytojob.com/apply/MQD6Cg04z9/Frontend-Developer?source=Our Career Page Widget">+ View details</a></div></div>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://app.jazz.co/widgets/basic/create/testco') {
      return { ok: true, text: async () => widgetJs };
    }
    if (u === 'https://discover.example/careers') {
      return { ok: true, text: async () => '<html><body><script src="https://app.jazz.co/widgets/basic/create/testco"></script></body></html>' };
    }
    if (u === 'https://discover.example') {
      return { ok: true, text: async () => '<html><body><nav><a href="/careers">Careers</a></nav></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res2 = mkRes();
  await handler(
    mkReq('POST', {
      company: { name: 'Discover Co', website: 'https://discover.example', careersUrl: '' },
      resumeText: 'React TypeScript frontend developer',
    }, { 'x-sync-key': 'testkey' }),
    res2,
  );
  check('test-company: widget source is the careers page', res2.body?.sourcePage === 'https://discover.example/careers', res2.body);
  check('test-company: widget lead found, score 75', res2.body?.leads?.length === 1 && res2.body?.leads[0]?.matchScore === 75, res2.body?.leads);
  // No jobs anywhere on the business site: null source + tried URLs.
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const res3 = mkRes();
  await handler(
    mkReq('POST', {
      company: { name: 'NoBoard Co', website: 'https://noboard.example', careersUrl: '' },
      resumeText: 'React developer',
    }, { 'x-sync-key': 'testkey' }),
    res3,
  );
  check('test-company: no jobs, tried URLs listed', res3.body?.sourcePage === null && res3.body?.triedUrls?.length === 3, res3.body);
  // A board link on its own is not a source: nothing found, and the
  // board is never contacted (the stub would serve jobs if asked).
  globalThis.fetch = boardsFetchStub;
  const res4 = mkRes();
  await handler(
    mkReq('POST', {
      company: { name: 'BoardOnly', website: '', careersUrl: 'https://boards.greenhouse.io/testcorp' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res4,
  );
  check('test-company: board link alone finds nothing', res4.body?.sourcePage === null && res4.body?.leads?.length === 0 && res4.body?.triedUrls?.length === 0, res4.body);
  // Auth + validation.
  const res5 = mkRes();
  await handler(mkReq('POST', { company: { name: 'X', website: 'https://x.example', careersUrl: '' }, resumeText: 'React' }, { 'x-sync-key': 'wrong' }), res5);
  check('test-company wrong key 401', res5.statusCode === 401, res5);
  const res6 = mkRes();
  await handler(mkReq('POST', { company: { name: '', website: '', careersUrl: '' }, resumeText: 'React' }, { 'x-sync-key': 'testkey' }), res6);
  check('test-company missing details 400', res6.statusCode === 400, res6);
}

async function testJazzhr() {
  // JazzHR: the widget script carries the listings, so fetching the
  // widget URL is enough — no browser needed. Covers the Goldschmitt
  // case: a careers page with a JazzHR embed and no Greenhouse/Lever/
  // Ashby board anywhere.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const widgetJs = `
<div id="resumator-job-job_20261027144142_FGDHFERUIMWO9F2B" class="resumator-job resumator-jobs-text"><div class="resumator-job-title resumator-jobs-text">Frontend Developer</div><div class="resumator-job-info resumator-jobs-text"><span class="resumator-job-location resumator-job-heading resumator-jobs-text">Location: </span>Remote<span class="resumator-job-department resumator-job-heading resumator-jobs-text">Department: </span>Timeguard Solutions</div><div class="resumator-job-view-details resumator-jobs-text"><a class="resumator-job-link resumator-jobs-text" target="_blank" href="https://testco.applytojob.com/apply/MQD6Cg04z9/Frontend-Developer?source=Our Career Page Widget">+ View details</a></div></div>
<div id="resumator-job-job_20261026090000_ABCDEFGH12345678" class="resumator-job resumator-jobs-text"><div class="resumator-job-title resumator-jobs-text">Loan Analyst</div><div class="resumator-job-info resumator-jobs-text"><span class="resumator-job-location resumator-job-heading resumator-jobs-text">Location: </span>Remote<span class="resumator-job-department resumator-job-heading resumator-jobs-text">Department: </span>Perkins Loan Servicing</div><div class="resumator-job-view-details resumator-jobs-text"><a class="resumator-job-link resumator-jobs-text" target="_blank" href="https://testco.applytojob.com/apply/BvPb4CUCsx/Loan-Analyst?source=Our Career Page Widget">+ View details</a></div></div>
`;
  const postings = jobsMod.parseJazzhrWidget(widgetJs);
  check('jazzhr: parsed 2 postings', postings.length === 2, postings);
  check('jazzhr: frontend posting fields', postings[0]?.title === 'Frontend Developer' && postings[0]?.location === 'Remote' && postings[0]?.url === 'https://testco.applytojob.com/apply/MQD6Cg04z9/Frontend-Developer' && postings[0]?.description === 'Timeguard Solutions' && postings[0]?.postedDate === '2026-10-27', postings[0]);
  // End to end via the test-company handler: website only, board
  // discovered on the /careers page's JazzHR embed.
  const testMod = freshRequire(`${OUT}/test-company.cjs`);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://app.jazz.co/widgets/basic/create/testco') {
      return { ok: true, text: async () => widgetJs };
    }
    if (u === 'https://testco.example/careers') {
      return { ok: true, text: async () => '<html><body><script src="https://app.jazz.co/widgets/basic/create/testco"></script></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'TestCo', website: 'https://testco.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res,
  );
  check('jazzhr: source is the careers page', res.body?.sourcePage === 'https://testco.example/careers', res.body);
  check('jazzhr: frontend lead found, loan gated out', res.body?.leads?.length === 1 && res.body?.leads[0]?.title === 'Frontend Developer', res.body?.leads);
  check('jazzhr: frontend lead scores 63', res.body?.leads[0]?.matchScore === 63, res.body?.leads[0]);
  // A widget link on its own is not a business page: nothing found.
  const res2 = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'TestCo', website: '', careersUrl: 'https://app.jazz.co/widgets/basic/create/testco' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res2,
  );
  check('jazzhr: widget link alone finds nothing', res2.body?.sourcePage === null && res2.body?.leads?.length === 0, res2.body);
  // Homepage nav link followed: the careers page lives at a
  // non-standard path (/join-us) that guessing would never try, and
  // the /careers and /jobs guesses are never reached.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://app.jazz.co/widgets/basic/create/testco') {
      return { ok: true, text: async () => widgetJs };
    }
    if (u === 'https://navco.example/join-us') {
      return { ok: true, text: async () => '<html><body><script src="https://app.jazz.co/widgets/basic/create/testco"></script></body></html>' };
    }
    if (u === 'https://navco.example') {
      return { ok: true, text: async () => '<html><body><nav><a href="/join-us">Careers</a></nav></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res3 = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'NavCo', website: 'https://navco.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res3,
  );
  check('nav: source is the nav-linked page', res3.body?.sourcePage === 'https://navco.example/join-us', res3.body);
  check('nav: guesses never tried', JSON.stringify(res3.body?.triedUrls) === JSON.stringify(['https://navco.example', 'https://navco.example/join-us']), res3.body?.triedUrls);
  check('nav: frontend lead found', res3.body?.leads?.length === 1 && res3.body?.leads[0]?.title === 'Frontend Developer', res3.body?.leads);
}

async function testBusinessSiteFirst() {
  // The rule: jobs must come from the business site itself — listings
  // parsed off its own careers page win over any board link, and a
  // board link given by the user is only a fallback.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const rawHtml = `<html><body>
<div class="job-listing"><h3>Frontend Developer</h3><p>Location: Remote</p><a href="/jobs/frontend-developer">Apply</a></div>
<div class="job-listing"><h3>Loan Analyst</h3><p>Location: Remote</p><a href="/jobs/loan-analyst">Apply</a></div>
</body></html>`;
  const parsed = jobsMod.parseCareersPage(rawHtml, 'https://rawco.example/careers');
  check('page parser: 2 listings from job blocks', parsed.length === 2, parsed);
  check('page parser: frontend fields resolved', parsed[0]?.title === 'Frontend Developer' && parsed[0]?.location === 'Remote' && parsed[0]?.url === 'https://rawco.example/jobs/frontend-developer', parsed[0]);
  const detailsHtml = `<html><body><div><strong>Frontend Developer</strong><p>Location: Remote</p><a href="/careers/frontend">+ View details</a></div></body></html>`;
  const parsedDetails = jobsMod.parseCareersPage(detailsHtml, 'https://detailco.example/careers');
  check('page parser: title + view-details pair', parsedDetails.length === 1 && parsedDetails[0]?.title === 'Frontend Developer' && parsedDetails[0]?.url === 'https://detailco.example/careers/frontend', parsedDetails);
  const heroHtml = `<html><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/careers">Careers</a></nav><div class="careers-hero"><h2>Join our team</h2><a href="/careers">See open roles</a></div></body></html>`;
  check('page parser: hero and nav yield nothing', jobsMod.parseCareersPage(heroHtml, 'https://hero.example/careers').length === 0);
  const hubHtml = `<html><body><div class="job-board"><a href="https://job-boards.greenhouse.io/hubco">View jobs</a></div></body></html>`;
  check('page parser: board hub link is not a listing', jobsMod.parseCareersPage(hubHtml, 'https://hub.example/careers').length === 0);
  // End to end: raw listings on the business site's own careers page.
  const testMod = freshRequire(`${OUT}/test-company.cjs`);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://rawco.example/careers') {
      return { ok: true, text: async () => rawHtml };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'RawCo', website: 'https://rawco.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res,
  );
  check('business-first: source is the careers page', res.body?.sourcePage === 'https://rawco.example/careers', res.body);
  check('business-first: frontend lead from the page', res.body?.leads?.length === 1 && res.body?.leads[0]?.title === 'Frontend Developer' && res.body?.leads[0]?.matchScore === 63, res.body?.leads);
  // Business site only: the raw page is used and the given board
  // link is ignored, never read.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('boards-api.greenhouse.io')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ jobs: [{ title: 'Frontend Engineer', location: { name: 'Remote US' }, absolute_url: 'https://job-boards.greenhouse.io/bothco/jobs/1', content: '<p>React frontend.</p>', created_at: '2026-10-20T00:00:00Z' }] }),
      };
    }
    if (u === 'https://bothco.example/careers') {
      return { ok: true, text: async () => rawHtml };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res2 = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'BothCo', website: 'https://bothco.example', careersUrl: 'https://boards.greenhouse.io/bothco' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res2,
  );
  check('business-first: page used, board link ignored', res2.body?.sourcePage === 'https://bothco.example/careers' && res2.body?.leads[0]?.title === 'Frontend Developer', res2.body);
}

async function testHalvik() {
  // Halvik pattern: the business page shows NO listings in its own
  // HTML — its job list is an embedded iSolved Hire iframe. The iframe
  // is part of the page, so reading it is reading the page.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const iframeHtml = `<html><body>
<a href="https://halvik.isolvedhire.com/iframe/1894977.html" class="list-group-item strip-side-borders"><div class="job-info"><h4>Front End Developer (Remote)</h4><ul class="listing-details"><li>McLean, VA, USA</li><li>Full Time</li></ul></div></a>
<a href="https://halvik.isolvedhire.com/iframe/1875066.html" class="list-group-item strip-side-borders"><div class="job-info"><h4>Full Stack Development Lead</h4><ul class="listing-details"><li>McLean, VA, USA</li><li>Full Time</li></ul></div></a>
</body></html>`;
  const parsed = jobsMod.parseIsolvedIframe(iframeHtml, 'https://halvik.isolvedhire.com/iframe/');
  check('isolved: 2 listings parsed', parsed.length === 2, parsed);
  check('isolved: remote title wins over office location', parsed[0]?.title === 'Front End Developer (Remote)' && parsed[0]?.location === 'Remote' && parsed[0]?.url === 'https://halvik.isolvedhire.com/iframe/1894977.html', parsed[0]);
  check('isolved: on-site role keeps office location', parsed[1]?.location === 'McLean, VA, USA', parsed[1]);
  // End to end: homepage nav -> careers page -> iframe -> lead.
  const testMod = freshRequire(`${OUT}/test-company.cjs`);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://halvik.isolvedhire.com/iframe/') {
      return { ok: true, text: async () => iframeHtml };
    }
    if (u === 'https://halvik.example/careers/') {
      return { ok: true, text: async () => '<html><body><iframe id="advanced_iframe" src="https://halvik.isolvedhire.com/iframe/"></iframe></body></html>' };
    }
    if (u === 'https://halvik.example') {
      return { ok: true, text: async () => '<html><body><nav><a href="/careers/">Careers</a></nav></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'Halvik', website: 'https://halvik.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res,
  );
  check('halvik: source is the careers page', res.body?.sourcePage === 'https://halvik.example/careers/', res.body);
  check('halvik: front end developer found at 63', res.body?.leads?.length === 1 && res.body?.leads[0]?.title === 'Front End Developer (Remote)' && res.body?.leads[0]?.matchScore === 63, res.body?.leads);
}

async function testHouseRx() {
  // House Rx pattern: the business page lists a few Webflow roles (all
  // sharing one generic detail link, no locations) AND embeds its
  // Greenhouse board — the Sr. UI Engineer role lives ONLY in the
  // embed. The page's sources union: raw + embed, never just the first.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const webflowHtml = `<html><body>
<div role="listitem" class="inner-jobs_item w-dyn-item"><a href="/career-details" target="_blank"><div>Pharmacy Technician / Care Coordinator</div></a></div>
<div role="listitem" class="inner-jobs_item w-dyn-item"><a href="/career-details" target="_blank"><div>Engineering Team Lead</div></a></div>
</body></html>`;
  const webflowParsed = jobsMod.parseCareersPage(webflowHtml, 'https://houserx.example/careers');
  check('webflow: same-URL roles do not collapse', webflowParsed.length === 2, webflowParsed);
  const ghJson = JSON.stringify({
    jobs: [
      { title: 'Sr. UI Engineer, Front End', location: { name: 'Remote' }, absolute_url: 'https://www.houserx.com/careers?gh_jid=4749398005', content: '<p>React TypeScript frontend developer with Storybook experience.</p>', created_at: '2026-10-20T00:00:00Z' },
      { title: 'Care Coordinator', location: { name: 'Cincinnati, OH' }, absolute_url: 'https://www.houserx.com/careers?gh_jid=4743625005', content: '<p>Pharmacy care.</p>', created_at: '2026-10-20T00:00:00Z' },
    ],
  });
  const ghParsed = jobsMod.parseGreenhouseJobs(ghJson);
  check('greenhouse embed: 2 postings parsed', ghParsed.length === 2 && ghParsed[0]?.title === 'Sr. UI Engineer, Front End' && ghParsed[0]?.location === 'Remote' && ghParsed[0]?.url === 'https://www.houserx.com/careers?gh_jid=4749398005', ghParsed[0]);
  const entParsed = jobsMod.parseGreenhouseJobs(JSON.stringify({ jobs: [{ title: 'T', location: { name: 'Remote' }, absolute_url: 'https://x.example/1', content: '<p>React &amp; TypeScript &amp;nbsp; work.</p><p>&lt;li&gt;item&lt;/li&gt;</p>', created_at: '2026-10-20T00:00:00Z' }] }));
  check('greenhouse: entities decoded, escaped tags stripped', entParsed[0]?.description === 'React & TypeScript work. item', entParsed[0]?.description);
  // End to end: careers page with Webflow items + embed script.
  const testMod = freshRequire(`${OUT}/test-company.cjs`);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('boards-api.greenhouse.io')) {
      return { ok: true, text: async () => ghJson };
    }
    if (u === 'https://houserx.example/careers') {
      return { ok: true, text: async () => `<html><body>${webflowHtml}<script src="https://boards.greenhouse.io/embed/job_board/js?for=houserx"></script></body></html>` };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const res = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'House Rx', website: 'https://houserx.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience',
    }, { 'x-sync-key': 'testkey' }),
    res,
  );
  check('houserx: source is the careers page', res.body?.sourcePage === 'https://houserx.example/careers', res.body);
  check('houserx: union postings seen 4', res.body?.postingsSeen === 4, res.body);
  check('houserx: sr ui engineer found at 81', res.body?.leads?.length === 1 && res.body?.leads[0]?.title === 'Sr. UI Engineer, Front End' && res.body?.leads[0]?.matchScore === 81, res.body?.leads);
  // Scores cap description-only matches at 5: a rich description
  // matching 16 resume terms would otherwise score 130 — now the
  // title matches 2 and only 5 of the 14 description-only matches
  // count, for 50 + 50*7/10 = 85.
  const richJson = JSON.stringify({
    jobs: [
      { title: 'Frontend Developer', location: { name: 'Remote' }, absolute_url: 'https://www.rich.example/careers?gh_jid=1', content: '<p>React TypeScript JavaScript frontend developer with Storybook design systems web built node api testing agile ci cd experience.</p>', created_at: '2026-10-20T00:00:00Z' },
    ],
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('boards-api.greenhouse.io')) {
      return { ok: true, text: async () => richJson };
    }
    if (u === 'https://rich.example/careers') {
      return { ok: true, text: async () => '<html><body><script src="https://boards.greenhouse.io/embed/job_board/js?for=rich"></script></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const resCap = mkRes();
  await testMod.default(
    mkReq('POST', {
      company: { name: 'Rich Co', website: 'https://rich.example', careersUrl: '' },
      resumeText: 'React TypeScript JavaScript frontend developer with Storybook design systems web built node api testing agile ci cd',
    }, { 'x-sync-key': 'testkey' }),
    resCap,
  );
  check('score: description-only matches cap at 5 (rich description scores 85, not 100)', resCap.body?.leads?.length === 1 && resCap.body?.leads[0]?.matchScore === 85, resCap.body?.leads);
}

async function testFitReasons() {
  // A related job that doesn't fit must say why: years bar above
  // what the resume shows, and explicit skill requirements missing
  // from the resume. A fitting job gets no reasons.
  const testMod = freshRequire(`${OUT}/test-company.cjs`);
  const ghJson = JSON.stringify({
    jobs: [
      { title: 'Senior Frontend Engineer', location: { name: 'Remote' }, absolute_url: 'https://fit.example/careers?gh_jid=1', content: '<p>8+ years of experience building web apps. Experience with Angular and Vue required. Must have AWS experience.</p>', created_at: '2026-10-20T00:00:00Z' },
      { title: 'Frontend Developer', location: { name: 'Remote' }, absolute_url: 'https://fit.example/careers?gh_jid=2', content: '<p>React TypeScript experience. 2 years of experience.</p>', created_at: '2026-10-20T00:00:00Z' },
    ],
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('boards-api.greenhouse.io')) {
      return { ok: true, text: async () => ghJson };
    }
    if (u === 'https://fit.example/careers') {
      return { ok: true, text: async () => '<html><body><script src="https://boards.greenhouse.io/embed/job_board/js?for=fit"></script></body></html>' };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const company = { name: 'Fit Co', website: 'https://fit.example', careersUrl: '' };
  const resA = mkRes();
  await testMod.default(
    mkReq('POST', { company, resumeText: 'React TypeScript frontend developer with 3 years of experience' }, { 'x-sync-key': 'testkey' }),
    resA,
  );
  const senior = resA.body?.leads?.find((l) => l.title === 'Senior Frontend Engineer');
  const junior = resA.body?.leads?.find((l) => l.title === 'Frontend Developer');
  check('fit: years reason vs resume', senior?.reasons?.some((r) => r.includes('Asks 8+ years') && r.includes('shows 3')), senior?.reasons);
  check('fit: skill reasons named', ['Angular', 'Vue', 'AWS'].every((s) => senior?.reasons?.some((r) => r.includes(s))), senior?.reasons);
  check('fit: fitting job has no reasons', Array.isArray(junior?.reasons) && junior.reasons.length === 0, junior?.reasons);
  const resC = mkRes();
  await testMod.default(
    mkReq('POST', { company, resumeText: 'React TypeScript frontend developer' }, { 'x-sync-key': 'testkey' }),
    resC,
  );
  const seniorC = resC.body?.leads?.find((l) => l.title === 'Senior Frontend Engineer');
  check('fit: no years figure stated honestly', seniorC?.reasons?.[0]?.includes("doesn't state a years figure"), seniorC?.reasons);
}

async function testCompaniesApi() {
  const lib = freshRequire(`${OUT}/finder-lib.cjs`);
  const col = new FakeCollection();
  await lib.addCompanies(col, [
    { name: 'Beta Corp', website: 'https://beta.example', source: 'Wikidata' },
    { name: 'Alpha LLC', website: 'https://alpha.example', source: 'Wikidata' },
    { name: 'Beta Corp', website: 'https://beta.example', source: 'Wikidata' },
    { name: 'Gamma', website: '', source: 'Wikidata' },
  ]);
  const all = await lib.listCompanies(col, { skip: 0, limit: 25, q: '' });
  check('listCompanies total 3 (dupe dropped, name-only kept)', all.total === 3, all);
  check('listCompanies sorted by name', all.companies[0]?.name === 'Alpha LLC', all.companies.map((c) => c.name));
  const filtered = await lib.listCompanies(col, { skip: 0, limit: 25, q: 'beta' });
  check('listCompanies q filter', filtered.total === 1 && filtered.companies[0]?.name === 'Beta Corp', filtered);
  const paged = await lib.listCompanies(col, { skip: 1, limit: 1, q: '' });
  check('listCompanies paging', paged.companies.length === 1 && paged.companies[0]?.name === 'Beta Corp', paged);
  // Dedupe rule: same domain + different name = different company.
  const added = await lib.addCompanies(col, [{ name: 'Beta Two', website: 'https://beta.example', source: 'Wikidata' }]);
  check('composite dedupe: same domain, new name inserts', added.inserted === 1, added);
  // Same name + same domain = dupe.
  const added2 = await lib.addCompanies(col, [{ name: 'Beta Corp', website: 'https://beta.example', source: 'Wikidata' }]);
  check('composite dedupe: same name+domain skips', added2.inserted === 0 && added2.skipped === 1, added2);
  // Migration.
  const appState = new FakeCollection();
  appState.docs.push({
    _id: 'jobboard',
    state: {
      companies: [
        { name: 'Migrated Co', website: 'https://migrated.example', careersUrl: '', category: '', source: 'Wikidata', addedAt: '2026-10-01T00:00:00Z' },
        { name: 'Beta Corp', website: 'https://beta.example', source: 'Wikidata' },
        { name: '', website: 'https://noname.example', source: 'Wikidata' },
      ],
      jobs: [],
    },
  });
  const mig = await lib.migrateStateCompanies(col, appState);
  check('migrate moved 1, skipped 1 (dupe), invalid 1 (no name)', mig.moved === 1 && mig.skipped === 1 && mig.invalid === 1, mig);
  check('migrate does NOT clear when invalid rows exist', mig.cleared === false, mig);
  const stateDoc = await appState.findOne({ _id: 'jobboard' });
  check('migrate leaves state companies intact when invalid', stateDoc.state.companies.length === 3, stateDoc.state);
  // Clean migration clears.
  const appState2 = new FakeCollection();
  appState2.docs.push({ _id: 'jobboard', state: { companies: [{ name: 'Clean Co', website: 'https://clean.example' }], jobs: [] } });
  const mig2 = await lib.migrateStateCompanies(col, appState2);
  check('clean migrate clears state companies', mig2.moved === 1 && mig2.cleared === true, mig2);
  const stateDoc2 = await appState2.findOne({ _id: 'jobboard' });
  check('clean migrate state companies now empty', stateDoc2.state.companies.length === 0, stateDoc2.state);
}

async function testWikidataPerType() {
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  // Route by QID in the query: type 0 returns 2 entities (one with two
  // websites); type 1 returns the SAME first entity under a different
  // website plus one new entity; other types are empty.
  const wdqs = async (url) => {
    const u = String(url);
    const bindings = [];
    if (u.includes('Q4830453')) {
      bindings.push(
        { company: { value: 'http://www.wikidata.org/entity/Q5001' }, companyLabel: { value: 'Acme Corp' }, website: { value: 'https://acme.example/uk' } },
        { company: { value: 'http://www.wikidata.org/entity/Q5001' }, companyLabel: { value: 'Acme Corp' }, website: { value: 'https://acme.example' } },
        { company: { value: 'http://www.wikidata.org/entity/Q5002' }, companyLabel: { value: 'Beta LLC' }, website: { value: 'https://beta2.example' } },
      );
    } else if (u.includes('Q783794')) {
      bindings.push(
        { company: { value: 'http://www.wikidata.org/entity/Q5001' }, companyLabel: { value: 'Acme Corp' }, website: { value: 'https://acme-other.example' } },
        { company: { value: 'http://www.wikidata.org/entity/Q5003' }, companyLabel: { value: 'Gamma Inc' }, website: { value: 'https://gamma.example' } },
      );
    }
    return { ok: true, json: async () => ({ results: { bindings } }) };
  };
  globalThis.fetch = routeFetch(wdqs, {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('per-type wikidata: added 3 (cross-type QID dupe removed)', out.added === 3, out);
  const acme = (await companiesCol.find({ name: 'Acme Corp' }).toArray())[0];
  check('per-type wikidata: first-seen website wins for QID dupe', acme?.website === 'https://acme.example', acme);
  check('per-type wikidata: sourceId stored', acme?.sourceId === 'Q5001', acme);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('per-type wikidata: walked all types', cursorDoc?.state?.wikidata?.typeIndex === 4, cursorDoc);
}

async function testEdgar() {
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  // Pre-exhaust wikidata so the press starts at EDGAR.
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 2, state: { wikidata: { typeIndex: 4, offsets: [0, 0, 0, 0] } } } },
    { upsert: true },
  );
  // Ticker map deliberately out of CIK order (adapter must sort by CIK).
  const tickerMap = {
    0: { cik_str: 300, ticker: 'CCC', title: 'Edgar Three' },
    1: { cik_str: 100, ticker: 'AAA', title: 'Edgar One' },
    2: { cik_str: 200, ticker: 'BBB', title: 'Foreign Co' },
    3: { cik_str: 400, ticker: 'DDD', title: 'NoSite Co' },
    4: { cik_str: 500, ticker: 'EEE', title: 'Edgar Five' },
    5: { cik_str: 600, ticker: 'FFF', title: 'Broken Co' },
  };
  const subs = async (url) => {
    const cik = String(url).match(/CIK(\d+)\.json/)?.[1];
    const data = {
      '0000000100': { name: 'Edgar One', website: 'https://edgarone.example', stateOfIncorporation: 'DE', addresses: { business: { stateOrCountry: 'DE' } } },
      '0000000300': { name: 'Edgar Three', website: 'https://edgarthree.example', stateOfIncorporation: '', addresses: { business: { stateOrCountry: 'CA' } } },
      '0000000200': { name: 'Foreign Co', website: 'https://foreign.example', stateOfIncorporation: '', addresses: { business: { stateOrCountry: 'NL' } } },
      '0000000400': { name: 'NoSite Co', website: '', stateOfIncorporation: 'TX', addresses: {} },
      '0000000500': { name: 'Edgar Five', website: 'https://edgarfive.example', stateOfIncorporation: 'TX', addresses: {} },
    };
    if (cik === '0000000600') throw new Error('submissions fetch failed');
    const d = data[cik];
    if (!d) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => d };
  };
  globalThis.fetch = routeFetch(
    // Organization adapters run after EDGAR: serve them empty pages so
    // the walk completes instead of erroring on an unserved URL.
    async () => ({ ok: true, json: async () => ({ results: { bindings: [] } }) }),
    tickerMap,
    subs,
  );
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('edgar: added 3 (US+website only)', out.added === 3, out);
  check('edgar: walk ends at Wikidata business keyset', out.source === 'Wikidata business keyset', out);
  check('edgar: exhausted after map end', out.exhausted === true, out);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('edgar: tickerIndex advanced past all 6 entries', cursorDoc?.state?.edgar?.tickerIndex === 6, cursorDoc);
  const one = (await companiesCol.find({ name: 'Edgar One' }).toArray())[0];
  check('edgar: CIK sourceId stored', one?.sourceId === 'CIK0000000100', one);
  const foreign = await companiesCol.find({ name: 'Foreign Co' }).toArray();
  check('edgar: foreign filer filtered', foreign.length === 0, foreign);
}

async function testFailureSkip() {
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  const tickerMap = {
    0: { cik_str: 100, ticker: 'AAA', title: 'Edgar One' },
    1: { cik_str: 200, ticker: 'BBB', title: 'Edgar Two' },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('query.wikidata.org')) {
      // Social queries (single social property, no P856) return empty so
      // the walk reaches the website adapter; website queries (P856)
      // fail, exercising the website adapter's failure-skip.
      if (u.includes('P856')) throw new Error('WDQS down');
      return { ok: true, json: async () => ({ results: { bindings: [] } }) };
    }
    if (u.includes('company_tickers.json')) return { ok: true, json: async () => tickerMap };
    if (u.includes('/submissions/CIK')) {
      const cik = u.match(/CIK(\d+)\.json/)?.[1];
      return {
        ok: true,
        json: async () => ({
          name: `Edgar ${cik}`,
          website: `https://edgar-${cik}.example`,
          stateOfIncorporation: 'DE',
          addresses: {},
        }),
      };
    }
    throw new Error('unexpected URL ' + u);
  };
  const deps = { companiesCol, metaCol, fetchFn: globalThis.fetch };
  const p1 = await runMod.runFindCompanies(deps, { limit: 2000 });
  check('failure-skip press 1: transient error', p1.added === 0 && typeof p1.error === 'string', p1);
  const p2 = await runMod.runFindCompanies(deps, { limit: 2000 });
  check('failure-skip press 2: transient error again', p2.added === 0 && typeof p2.error === 'string', p2);
  const p3 = await runMod.runFindCompanies(deps, { limit: 2000 });
  check('failure-skip press 3: wikidata skipped, edgar adds 2', p3.added === 2 && typeof p3.note === 'string' && p3.note.includes('skipped'), p3);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('failure-skip: cursor past wikidata and edgar (now at organization)', cursorDoc?.sourceIndex === 4 && cursorDoc?.state?.edgar?.tickerIndex === 2, cursorDoc);
}

async function testExactCounts() {
  // A call must add EXACTLY the requested count, never more, even when a
  // source page yields more fresh companies than the call needs. The
  // excess is banked in the cursor's pending buffer and drained first on
  // the next call — nothing is lost, nothing repeats, nothing overshoots.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  const page = (startQ, count) => {
    const bindings = [];
    for (let e = 0; e < count; e++) {
      const q = startQ + e;
      bindings.push({
        company: { value: `http://www.wikidata.org/entity/Q${q}` },
        companyLabel: { value: `ExactCo ${q}` },
        website: { value: `https://exactco${q}.example` },
      });
    }
    return bindings;
  };
  globalThis.fetch = routeFetch(wdqsFetchFactory([page(5000, 150), page(6000, 150)]), {}, null);
  const deps = { companiesCol, metaCol, fetchFn: globalThis.fetch };
  const c1 = await runMod.runFindCompanies(deps, { limit: 100 });
  check('exact: call 1 added exactly 100 (page yielded 150)', c1.added === 100, c1);
  const cur1 = await metaCol.findOne({ _id: 'find-companies' });
  check('exact: call 1 banked 50 pending', (cur1?.pending ?? []).length === 50, cur1?.pending?.length);
  const c2 = await runMod.runFindCompanies(deps, { limit: 100 });
  check('exact: call 2 added exactly 100 (50 pending + 50 fresh)', c2.added === 100, c2);
  const cur2 = await metaCol.findOne({ _id: 'find-companies' });
  check('exact: call 2 banked 100 pending', (cur2?.pending ?? []).length === 100, cur2?.pending?.length);
  check('exact: total 200, no repeats', (await companiesCol.countDocuments()) === 200, await companiesCol.countDocuments());
  // Drain-only call: pending covers the whole request, so no fetch is
  // needed — prove it by making fetch throw.
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  const deps2 = { companiesCol, metaCol, fetchFn: globalThis.fetch };
  const c3 = await runMod.runFindCompanies(deps2, { limit: 100 });
  check('exact: call 3 drained pending without fetching', c3.added === 100 && !c3.error, c3);
  const cur3 = await metaCol.findOne({ _id: 'find-companies' });
  check('exact: pending empty after full drain', (cur3?.pending ?? []).length === 0, cur3?.pending?.length);
  check('exact: total 300, still no repeats', (await companiesCol.countDocuments()) === 300, await companiesCol.countDocuments());
}

async function testSocialPresence() {
  // Online presence = website AND/OR social media. The query binds
  // ?website to the real website when one exists, else the first social
  // profile URL — so the adapter must include social-only rows (with
  // the social URL as their link) and still prefer a real website when
  // both exist for one entity.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  const bindings = [
    // Social-only entity: no website, only a Facebook profile URL.
    { company: { value: 'http://www.wikidata.org/entity/Q7001' }, companyLabel: { value: 'Social Only Co' }, website: { value: 'https://www.facebook.com/socialonlyco' } },
    // Entity with both: social row + real website row — website must win.
    { company: { value: 'http://www.wikidata.org/entity/Q7002' }, companyLabel: { value: 'Both Co' }, website: { value: 'https://www.facebook.com/bothco' } },
    { company: { value: 'http://www.wikidata.org/entity/Q7002' }, companyLabel: { value: 'Both Co' }, website: { value: 'https://bothco.com' } },
  ];
  globalThis.fetch = routeFetch(wdqsFetchFactory([bindings]), {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('social: added 2 (social-only + both)', out.added === 2, out);
  const social = (await companiesCol.find({ name: 'Social Only Co' }).toArray())[0];
  check('social: social-only row keeps its profile URL', social?.website === 'https://www.facebook.com/socialonlyco', social);
  const both = (await companiesCol.find({ name: 'Both Co' }).toArray())[0];
  check('social: real website wins over social URL', both?.website === 'https://bothco.com', both);
}

async function testWikidataSocial() {
  // Social runs first: a fresh press hits the social adapter, whose
  // single-pattern queries bind the profile URL as the website.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  const bindings = [
    { company: { value: 'http://www.wikidata.org/entity/Q8001' }, companyLabel: { value: 'Fb Only Co' }, website: { value: 'https://www.facebook.com/fbonlyco' } },
    { company: { value: 'http://www.wikidata.org/entity/Q8002' }, companyLabel: { value: 'Ig Only Co' }, website: { value: 'https://www.instagram.com/igonlyco' } },
  ];
  globalThis.fetch = routeFetch(wdqsFetchFactory([bindings]), {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2 },
  );
  check('wikidata-social: added 2 social-only rows', out.added === 2, out);
  check('wikidata-social: source label', out.source === 'Wikidata social', out);
  const fb = (await companiesCol.find({ name: 'Fb Only Co' }).toArray())[0];
  check('wikidata-social: facebook URL stored', fb?.website === 'https://www.facebook.com/fbonlyco', fb);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('wikidata-social: combo cursor advanced', cursorDoc?.state?.['wikidata-social']?.comboIndex === 1, cursorDoc?.state?.['wikidata-social']);
}

async function testWebsiteUpgrade() {
  // A stored social link upgrades to the real website when the website
  // walk later finds the same company (same QID); a real website never
  // downgrades to a social URL.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  // Upgrade: seed a social row, then run the website adapter past it.
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await companiesCol.insertMany([{
    name: 'Up Co', nameKey: 'up co', website: 'https://www.facebook.com/upco',
    domain: 'facebook.com', careersUrl: '', category: 'General',
    source: 'Wikidata', sourceId: 'Q9001', addedAt: new Date().toISOString(),
  }]);
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 1, state: { wikidata: { typeIndex: 0, offsets: [0, 0, 0, 0] } } } },
    { upsert: true },
  );
  const webBindings = [
    { company: { value: 'http://www.wikidata.org/entity/Q9001' }, companyLabel: { value: 'Up Co' }, website: { value: 'https://upco.com' } },
  ];
  globalThis.fetch = routeFetch(wdqsFetchFactory([webBindings]), {}, null);
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('upgrade: dupe website row adds 0', out.added === 0, out);
  const up = (await companiesCol.find({ name: 'Up Co' }).toArray())[0];
  check('upgrade: social link replaced by real website', up?.website === 'https://upco.com' && up?.domain === 'upco.com', up);
  // No downgrade: seed a real-website row, then run a social page for it.
  const companiesCol2 = new FakeCollection();
  const metaCol2 = new FakeCollection();
  await companiesCol2.insertMany([{
    name: 'Real Co', nameKey: 'real co', website: 'https://realco.com',
    domain: 'realco.com', careersUrl: '', category: 'General',
    source: 'Wikidata', sourceId: 'Q9002', addedAt: new Date().toISOString(),
  }]);
  const socialBindings = [
    { company: { value: 'http://www.wikidata.org/entity/Q9002' }, companyLabel: { value: 'Real Co' }, website: { value: 'https://www.facebook.com/realco' } },
  ];
  globalThis.fetch = routeFetch(wdqsFetchFactory([socialBindings]), {}, null);
  const out2 = await runMod.runFindCompanies(
    { companiesCol: companiesCol2, metaCol: metaCol2, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('upgrade: social dupe adds 0', out2.added === 0, out2);
  const real = (await companiesCol2.find({ name: 'Real Co' }).toArray())[0];
  check('upgrade: real website never downgrades', real?.website === 'https://realco.com', real);
}

async function testUpgradeCollision() {
  // 2026-11-03 regression: the same business under two source ids — a
  // social row (Q9001) and a real-website row (Q9009) with the same
  // name+domain — used to make the website walk throw E11000 out of
  // the press (upgrading the social row into the real row's pair),
  // bricking every later press on that page because the cursor never
  // advances past a throwing page. The press must now skip the
  // colliding upgrade and complete.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await companiesCol.insertMany([
    {
      name: 'The GameHub', nameKey: 'the gamehub', website: 'https://www.facebook.com/thegamehub',
      domain: 'facebook.com', careersUrl: '', category: 'General',
      source: 'Wikidata', sourceId: 'Q9001', addedAt: new Date().toISOString(),
    },
    {
      name: 'The GameHub', nameKey: 'the gamehub', website: 'https://thegamehub.io',
      domain: 'thegamehub.io', careersUrl: '', category: 'General',
      source: 'Wikidata', sourceId: 'Q9009', addedAt: new Date().toISOString(),
    },
  ]);
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 1, state: { wikidata: { typeIndex: 0, offsets: [0, 0, 0, 0] } } } },
    { upsert: true },
  );
  const webBindings = [
    { company: { value: 'http://www.wikidata.org/entity/Q9001' }, companyLabel: { value: 'The GameHub' }, website: { value: 'https://thegamehub.io' } },
  ];
  globalThis.fetch = routeFetch(wdqsFetchFactory([webBindings]), {}, null);
  let out;
  let threw = null;
  try {
    out = await runMod.runFindCompanies(
      { companiesCol, metaCol, fetchFn: globalThis.fetch },
      { limit: 2000 },
    );
  } catch (e) {
    threw = e;
  }
  check('upgrade-collision: press completes without throwing', threw === null, threw && String(threw));
  check('upgrade-collision: no error on result', out && !out.error, out);
  const rows = await companiesCol.find({ name: 'The GameHub' }).toArray();
  const social = rows.find((r) => r.sourceId === 'Q9001');
  const real = rows.find((r) => r.sourceId === 'Q9009');
  check('upgrade-collision: social row left untouched', social?.website === 'https://www.facebook.com/thegamehub' && social?.domain === 'facebook.com', social);
  check('upgrade-collision: real row untouched', real?.website === 'https://thegamehub.io' && real?.domain === 'thegamehub.io', real);
  check('upgrade-collision: still 2 rows, no dup insert', rows.length === 2, rows.length);
}

async function testOrgKeysetPaging() {
  // 2026-11-03: the OFFSET organization walk was permanently skipped
  // after 3 slow deep pages. Its keyset replacement resumes from the
  // last entity IRI instead of skipping N rows: page 2's query must
  // carry a FILTER past page 1's last entity, and a short page must
  // exhaust the source.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 5, state: {}, pending: [] } },
    { upsert: true },
  );
  const seenUrls = [];
  // Page 1 must be a FULL 300-binding page, or the adapter correctly
  // treats it as the final page and never fetches page 2.
  const fullPage = [];
  for (let q = 100; q < 400; q++) {
    fullPage.push({ company: { value: `http://www.wikidata.org/entity/Q${q}` }, companyLabel: { value: `Keyset ${q}` }, website: { value: `https://keyset${q}.example` } });
  }
  const pages = [
    fullPage,
    [
      { company: { value: 'http://www.wikidata.org/entity/Q400' }, companyLabel: { value: 'Keyset D' }, website: { value: 'https://keysetd.example' } },
      { company: { value: 'http://www.wikidata.org/entity/Q500' }, companyLabel: { value: 'Keyset E' }, website: { value: 'https://keysete.example' } },
    ],
  ];
  let calls = 0;
  globalThis.fetch = async (url) => {
    // URLSearchParams encodes spaces as +; decode them for readable asserts.
    seenUrls.push(decodeURIComponent(String(url)).replace(/\+/g, ' '));
    const page = pages[calls] ?? [];
    calls += 1;
    return { ok: true, json: async () => ({ results: { bindings: page } }) };
  };
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('keyset: added 302 across both pages', out.added === 302, out);
  check('keyset: source label (walk continues into business keyset after)', out.source === 'Wikidata business keyset', out);
  check('keyset: page 1 has no resume filter', !seenUrls[0].includes('FILTER(STR'), seenUrls[0]);
  check(
    'keyset: page 2 filters past page 1 last entity (Q399)',
    seenUrls[1].includes("FILTER(STR(?company) > 'http://www.wikidata.org/entity/Q399')") &&
      seenUrls[1].includes('ORDER BY STR(?company)'),
    seenUrls[1],
  );
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check(
    'keyset: cursor past source, lastIri at Q500',
    cursorDoc?.sourceIndex === 8 &&
      cursorDoc?.state?.['wikidata-organization-keyset']?.lastIri === 'http://www.wikidata.org/entity/Q500',
    cursorDoc,
  );
}

async function testNeverSkip() {
  // 2026-11-03: a slow-but-alive source must NEVER be skipped. Three
  // straight failed pages on the neverSkip keyset adapter must each
  // end with a retry-safe error and leave the cursor exactly where it
  // was — no skip note, no advance, no silent abandonment.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 5, state: {}, pending: [] } },
    { upsert: true },
  );
  globalThis.fetch = async () => {
    throw new Error('WDQS slow');
  };
  const deps = { companiesCol, metaCol, fetchFn: globalThis.fetch };
  for (let i = 1; i <= 3; i++) {
    const p = await runMod.runFindCompanies(deps, { limit: 2000 });
    check(`neverSkip press ${i}: transient error, never skipped`, p.added === 0 && typeof p.error === 'string' && !(p.note ?? '').includes('skipped'), p);
  }
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('neverSkip: cursor still at keyset after 3 failures', cursorDoc?.sourceIndex === 5, cursorDoc);
}

async function testTypesKeysetPaging() {
  // 2026-11-03: multi-type keyset walk. Phase 1 sorts IRIs + websites
  // without labels; phase 2 looks labels up via VALUES chunks. A full
  // 300-binding page must resume from its last IRI on the next press
  // (FILTER past it), and labels must merge onto the rows.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 6, state: {}, pending: [] } },
    { upsert: true },
  );
  const seenUrls = [];
  const fullPage = [];
  for (let q = 1000; q < 1300; q++) {
    fullPage.push({ company: { value: `http://www.wikidata.org/entity/Q${q}` }, website: { value: `https://place${q}.example` } });
  }
  let phase1Calls = 0;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    seenUrls.push(u);
    if (u.includes('VALUES')) {
      const iris = [...new Set([...u.matchAll(/entity\/(Q\d+)/g)].map((m) => m[1]))];
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: iris.map((qid) => ({
              company: { value: `http://www.wikidata.org/entity/${qid}` },
              companyLabel: { value: `Label-${qid}` },
            })),
          },
        }),
      };
    }
    phase1Calls += 1;
    const page = phase1Calls === 1 ? fullPage : [];
    return { ok: true, json: async () => ({ results: { bindings: page } }) };
  };
  const deps = { companiesCol, metaCol, fetchFn: globalThis.fetch };
  const p1 = await runMod.runFindCompanies(deps, { limit: 300 });
  check('types-keyset press 1: added 300', p1.added === 300, p1);
  const row = (await companiesCol.find({ name: 'Label-Q1000' }).toArray())[0];
  check('types-keyset: phase-2 label merged onto row', row?.website === 'https://place1000.example' && row?.sourceId === 'Q1000', row);
  const cur1 = await metaCol.findOne({ _id: 'find-companies' });
  check(
    'types-keyset press 1: still on type 0, lastIri at Q1299',
    cur1?.sourceIndex === 6 &&
      cur1?.state?.['wikidata-types-keyset']?.typeIndex === 0 &&
      cur1?.state?.['wikidata-types-keyset']?.lastIri === 'http://www.wikidata.org/entity/Q1299',
    cur1,
  );
  const p2 = await runMod.runFindCompanies(deps, { limit: 2000 });
  check('types-keyset press 2: added 0, exhausted', p2.added === 0 && p2.exhausted === true, p2);
  const press2Phase1 = seenUrls.filter((u) => !u.includes('VALUES')).slice(1);
  check(
    'types-keyset press 2: first phase-1 filters past Q1299',
    press2Phase1[0].includes("FILTER(STR(?company) > 'http://www.wikidata.org/entity/Q1299')"),
    press2Phase1[0],
  );
}

async function testTypesSkipRetry() {
  // 2026-11-03: a type failing 3 times is skipped (not the whole
  // source), and skipped types get exactly one retry round at the end
  // of the list before the source exhausts.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 6, state: {}, pending: [] } },
    { upsert: true },
  );
  let type0Throws = 0;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('VALUES')) {
      const iris = [...new Set([...u.matchAll(/entity\/(Q\d+)/g)].map((m) => m[1]))];
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: iris.map((qid) => ({
              company: { value: `http://www.wikidata.org/entity/${qid}` },
              companyLabel: { value: `Label-${qid}` },
            })),
          },
        }),
      };
    }
    const m = u.match(/wdt:P31 wd:(Q\d+)/);
    const typeId = m ? m[1] : '';
    if (typeId === 'Q3918') {
      type0Throws += 1;
      throw new Error('WDQS down for universities');
    }
    // Every other type: one short page, one distinct company.
    return {
      ok: true,
      json: async () => ({
        results: {
          bindings: [
            { company: { value: `http://www.wikidata.org/entity/${typeId}99` }, website: { value: `https://type${typeId}.example` } },
          ],
        },
      }),
    };
  };
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('types-skip-retry: added 20 (16 surviving types + 4 business types)', out.added === 20, out);
  check('types-skip-retry: exhausted after retry round', out.exhausted === true, out);
  check('types-skip-retry: dead type tried 3 + 3 times', type0Throws === 6, type0Throws);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('types-skip-retry: cursor past source', cursorDoc?.sourceIndex === 8, cursorDoc);
}

async function testBusinessKeyset() {
  // 2026-11-11: the four business types were only ever walked by the
  // OFFSET website adapter, which can be permanently skipped after 3
  // slow pages — and no later source walks business types at all. The
  // appended business keyset re-walk recovers the missed remainder
  // and upgrades social-only rows (same QID) to their real website.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  // A stored Facebook-only row for Q9101 (Concentrix-shaped: found by
  // the social walk, never upgraded because no later source emitted
  // its website row).
  await companiesCol.insertMany([{
    name: 'Bpo Co', nameKey: 'bpo co', website: 'https://www.facebook.com/bpoco',
    domain: 'facebook.com', careersUrl: '', category: 'General',
    source: 'Wikidata', sourceId: 'Q9101', addedAt: new Date().toISOString(),
  }]);
  // Cursor past the exhausted types walk: the new adapter is next.
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 7, state: {}, pending: [] } },
    { upsert: true },
  );
  // Route by P31: business returns the FB-only QID with its real
  // website plus one new company; company / public company return one
  // new company each; enterprise is empty (exhausts the walk).
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('VALUES')) {
      const iris = [...new Set([...u.matchAll(/entity\/(Q\d+)/g)].map((m) => m[1]))];
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: iris.map((qid) => ({
              company: { value: `http://www.wikidata.org/entity/${qid}` },
              companyLabel: { value: `Label-${qid}` },
            })),
          },
        }),
      };
    }
    const m = u.match(/wdt:P31 wd:(Q\d+)/);
    const typeId = m ? m[1] : '';
    const page = {
      Q4830453: [
        { company: { value: 'http://www.wikidata.org/entity/Q9101' }, website: { value: 'https://bpoco.example' } },
        { company: { value: 'http://www.wikidata.org/entity/Q9102' }, website: { value: 'https://newbpo.example' } },
      ],
      Q783794: [
        { company: { value: 'http://www.wikidata.org/entity/Q9103' }, website: { value: 'https://otherbpo.example' } },
      ],
      Q891723: [
        { company: { value: 'http://www.wikidata.org/entity/Q9104' }, website: { value: 'https://pubbpo.example' } },
      ],
    }[typeId] ?? [];
    return { ok: true, json: async () => ({ results: { bindings: page } }) };
  };
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('business-keyset: added 3 (FB-only QID is an upgrade, not an add)', out.added === 3, out);
  check('business-keyset: source label', out.source === 'Wikidata business keyset', out);
  check('business-keyset: exhausted after the 4 types', out.exhausted === true, out);
  const bpo = (await companiesCol.find({ name: 'Bpo Co' }).toArray())[0];
  check('business-keyset: social row upgraded to real website', bpo?.website === 'https://bpoco.example' && bpo?.domain === 'bpoco.example', bpo);
  const total = await companiesCol.countDocuments();
  check('business-keyset: total 4 rows, no dupes', total === 4, total);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check(
    'business-keyset: cursor past source, all 4 types walked',
    cursorDoc?.sourceIndex === 8 &&
      cursorDoc?.state?.['wikidata-business-keyset']?.typeIndex === 4,
    cursorDoc,
  );
  // A second press from the exhausted cursor adds nothing.
  const out2 = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('business-keyset: exhausted press adds 0, no error', out2.added === 0 && out2.exhausted === true && !out2.error, out2);
}

async function testBusinessKeysetTypeSkip() {
  // Per-type failure isolation, like the types walk: a dead business
  // type is skipped (not the whole source) and gets exactly one retry
  // round at the end of the list before the source exhausts. The
  // adapter counts WDQS failures internally, so a throwing fetch
  // never reaches the runner's 3-failure source skip.
  const runMod = freshRequire(`${OUT}/find-companies.cjs`);
  const companiesCol = new FakeCollection();
  const metaCol = new FakeCollection();
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { version: 2, sourceIndex: 7, state: {}, pending: [] } },
    { upsert: true },
  );
  let type0Throws = 0;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('VALUES')) {
      const iris = [...new Set([...u.matchAll(/entity\/(Q\d+)/g)].map((m) => m[1]))];
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: iris.map((qid) => ({
              company: { value: `http://www.wikidata.org/entity/${qid}` },
              companyLabel: { value: `Label-${qid}` },
            })),
          },
        }),
      };
    }
    const m = u.match(/wdt:P31 wd:(Q\d+)/);
    const typeId = m ? m[1] : '';
    if (typeId === 'Q4830453') {
      type0Throws += 1;
      throw new Error('WDQS down for business');
    }
    const page = {
      Q783794: [
        { company: { value: 'http://www.wikidata.org/entity/Q9103' }, website: { value: 'https://otherbpo.example' } },
      ],
      Q891723: [
        { company: { value: 'http://www.wikidata.org/entity/Q9104' }, website: { value: 'https://pubbpo.example' } },
      ],
      Q6881511: [
        { company: { value: 'http://www.wikidata.org/entity/Q9105' }, website: { value: 'https://entbpo.example' } },
      ],
    }[typeId] ?? [];
    return { ok: true, json: async () => ({ results: { bindings: page } }) };
  };
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('business-skip-retry: added 3 (one per surviving type)', out.added === 3, out);
  check('business-skip-retry: exhausted after retry round', out.exhausted === true, out);
  check('business-skip-retry: dead type tried 3 + 3 times', type0Throws === 6, type0Throws);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check(
    'business-skip-retry: cursor past source, dead type still recorded',
    cursorDoc?.sourceIndex === 8 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-business-keyset']?.skipped) === JSON.stringify([0]) &&
      cursorDoc?.state?.['wikidata-business-keyset']?.round === 1,
    cursorDoc,
  );
}

async function testPortalSearch() {
  // The search-interaction step: on a rendered search-portal page, find
  // the job-search box, submit (empty first, then the resume term), and
  // extract from the post-search results. Pure selection and the
  // orchestration are tested with canned descriptors and a fake page —
  // no real browser runs in this suite.
  const searchMod = freshRequire(`${OUT}/render-search.cjs`);
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);

  const mkInput = (over) => ({
    index: 0, type: 'text', name: '', id: '', placeholder: '', ariaLabel: '', role: '', cls: '', title: '', labelText: '', describedBy: '', formIndex: 0, visible: true, top: 0, ...over,
  });
  const mkButton = (over) => ({
    index: 0, text: '', ariaLabel: '', title: '', type: 'submit', formIndex: 0, visible: true, top: 0, ...over,
  });

  // --- Pure selection ---
  const portal = {
    inputs: [
      mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: 0 }),
      mkInput({ index: 1, name: 'location', placeholder: 'Search by Location', formIndex: 0 }),
    ],
    buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 })],
    forms: [{ action: '/jobs', method: 'get' }],
  };
  const sel = searchMod.selectSearchInput(portal);
  check('portal-search: keyword input picked over location input', sel?.input?.index === 0, sel);
  check('portal-search: same-form Search button picked', sel?.button?.index === 0, sel);
  check('portal-search: form action carried', sel?.formAction === '/jobs', sel);
  const locOnly = {
    inputs: [mkInput({ index: 0, name: 'location', placeholder: 'Search by Location', formIndex: 0 })],
    buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 })],
    forms: [{ action: '/jobs', method: 'get' }],
  };
  check('portal-search: location-only input is not a keyword box', searchMod.selectSearchInput(locOnly) === null, null);
  const hidden = {
    inputs: [mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', visible: false })],
    buttons: [],
    forms: [{ action: '', method: 'get' }],
  };
  check('portal-search: hidden keyword input ignored', searchMod.selectSearchInput(hidden) === null, null);
  const qOnly = {
    inputs: [mkInput({ index: 0, name: 'q', type: 'search', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  const selQ = searchMod.selectSearchInput(qOnly);
  check('portal-search: bare q input qualifies, no button means Enter', selQ?.input?.index === 0 && selQ?.button === null, selQ);
  check(
    'portal-search: board form action refused',
    searchMod.isSearchActionAllowed('https://boards.greenhouse.io/embed/job_board/js?for=x', 'https://portal.example/careers') === false,
    null,
  );
  check(
    'portal-search: site-search action refused, jobs/search actions allowed',
    searchMod.isSiteSearchAction('/', 'https://portal.example/careers') === true &&
      searchMod.isSiteSearchAction('/jobs', 'https://portal.example/careers') === false &&
      searchMod.isSiteSearchAction('', 'https://portal.example/careers') === false &&
      searchMod.isSiteSearchAction('/search-jobs', 'https://portal.example/careers') === false &&
      searchMod.isSiteSearchAction('/results', 'https://portal.example/careers') === false &&
      searchMod.isSiteSearchAction('/listing', 'https://portal.example/careers') === false,
    null,
  );
  check(
    'portal-search: same-page action allowed',
    searchMod.isSearchActionAllowed('/jobs', 'https://portal.example/careers') === true &&
      searchMod.isSearchActionAllowed('', 'https://portal.example/careers') === true,
    null,
  );
  // A bare "Search" button (Walmart, Phenom) is the portal's own
  // submit, and the one nearest the chosen input wins when a page
  // carries two search boxes (header + hero).
  const twoBoxes = {
    inputs: [mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: -1, top: 2000 })],
    buttons: [
      mkButton({ index: 0, text: '', ariaLabel: 'Search', type: 'button', formIndex: -1, top: 40 }),
      mkButton({ index: 1, text: '', ariaLabel: 'Search', type: 'button', formIndex: -1, top: 1990 }),
    ],
    forms: [],
  };
  const selTwo = searchMod.selectSearchInput(twoBoxes);
  check('portal-search: nearest Search button wins, not the first in the DOM', selTwo?.button?.index === 1, selTwo);
  // Form widening (2026-11-11 canary): a box labelled by role /
  // class / <label> / aria-describedby qualifies even when its name
  // and placeholder say nothing — Alorica's bling-ai box is a
  // combobox described as "a search field", not named.
  const combobox = {
    inputs: [mkInput({ index: 0, name: 'keyword', role: 'combobox', ariaLabel: 'Search', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  check('portal-search: role=combobox + aria-label Search qualifies', searchMod.selectSearchInput(combobox)?.input?.index === 0, searchMod.selectSearchInput(combobox));
  const classBox = {
    inputs: [mkInput({ index: 0, name: 'q2', cls: 'job-search-input', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  check('portal-search: job-search class qualifies', searchMod.selectSearchInput(classBox)?.input?.index === 0, searchMod.selectSearchInput(classBox));
  const labelBox = {
    inputs: [mkInput({ index: 0, name: 'kw', labelText: 'Search Jobs', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  check('portal-search: <label> text qualifies', searchMod.selectSearchInput(labelBox)?.input?.index === 0, searchMod.selectSearchInput(labelBox));
  const describedBox = {
    inputs: [mkInput({ index: 0, name: 's', describedBy: 'This is a search field with an auto-suggest feature attached', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  check('portal-search: aria-describedby "search field" qualifies', searchMod.selectSearchInput(describedBox)?.input?.index === 0, searchMod.selectSearchInput(describedBox));
  const locClass = {
    inputs: [mkInput({ index: 0, name: 'loc', cls: 'location-field', placeholder: 'Search by Location', formIndex: -1 })],
    buttons: [],
    forms: [],
  };
  check('portal-search: location class still rejects the box', searchMod.selectSearchInput(locClass) === null, null);
  const titleButton = {
    inputs: [mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: -1, top: 0 })],
    buttons: [mkButton({ index: 0, text: '', ariaLabel: '', title: 'Search', type: 'button', formIndex: -1, top: 5 })],
    forms: [],
  };
  check('portal-search: submit button labelled by title only is picked', searchMod.selectSearchInput(titleButton)?.button?.index === 0, searchMod.selectSearchInput(titleButton));
  check('portal-search: 3 job links alone are NOT listings (trending-role cards)', searchMod.hasVisibleListings({ jobLinks: 3, resultsText: false }) === false, null);
  check('portal-search: 25 job links, no count, are NOT listings (Walmart homepage)', searchMod.hasVisibleListings({ jobLinks: 25, resultsText: false }) === false, null);
  check('portal-search: results count needs a job link', searchMod.hasVisibleListings({ jobLinks: 0, resultsText: true }) === false, null);
  check('portal-search: results count + 1 link counts', searchMod.hasVisibleListings({ jobLinks: 1, resultsText: true }) === true, null);
  check('portal-search: 2 links, no count, is not listings', searchMod.hasVisibleListings({ jobLinks: 2, resultsText: false }) === false, null);
  check(
    'portal-search: scan summary counts visible inputs and best score',
    JSON.stringify(searchMod.summarizeScan({
      inputs: [
        mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: 0 }),
        mkInput({ index: 1, name: 'location', placeholder: 'Search by Location', formIndex: 0 }),
        mkInput({ index: 2, name: 'keyword', placeholder: 'Search by Keyword', visible: false }),
      ],
      buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 }), mkButton({ index: 1, text: 'Help', visible: false })],
      forms: [{ action: '/jobs', method: 'get' }],
    })) === JSON.stringify({ inputs: 3, visibleInputs: 2, bestScore: 7, buttons: 1 }),
    null,
  );
  // The REAL countJobListings against a stubbed document: a "0 jobs"
  // shell is NOT listings, even with job-looking nav links — the
  // Concentrix portal-direct bug (2026-11-11), where "Search results
  // (0 jobs available)" + "Search & Apply" links read as listings and
  // the search never ran.
  const realCount = (bodyText, anchors) => {
    const prevDocument = globalThis.document;
    globalThis.document = {
      body: { innerText: bodyText },
      querySelectorAll: (sel) =>
        sel === 'a'
          ? anchors.map((a) => ({
              getAttribute: (name) => (name === 'href' ? a.href : ''),
              innerText: a.text,
              getBoundingClientRect: () => ({ width: 100, height: 20 }),
            }))
          : [],
    };
    try {
      return searchMod.countJobListings();
    } finally {
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
    }
  };
  const shellCount = realCount('Search results (0 jobs available) No jobs match your search.', [
    { href: 'https://jobs.concentrix.com/job-search/', text: 'Search & Apply' },
    { href: 'https://jobs.concentrix.com/job-search/', text: 'Search & Apply' },
  ]);
  check(
    'portal-search: "0 jobs available" shell is NOT listings (Concentrix)',
    shellCount.resultsText === false && shellCount.jobLinks === 2 && searchMod.hasVisibleListings(shellCount) === false,
    shellCount,
  );
  const foundCount = realCount('Showing 1-25 of 4,659 jobs', [
    { href: '/jobs/customer-support-specialist', text: 'Customer Support Specialist' },
  ]);
  check(
    'portal-search: "1-25 of 4,659 jobs" + a job link IS listings',
    foundCount.resultsText === true && foundCount.jobLinks === 1 && searchMod.hasVisibleListings(foundCount) === true,
    foundCount,
  );
  check(
    'portal-search: "Showing 0 results" is NOT a results line',
    realCount('Showing 0 results for your search.', []).resultsText === false,
    null,
  );
  check(
    'portal-search: "9 roles across all departments" counts as a results line (Rippling)',
    realCount('9 roles across all departments in all locations', []).resultsText === true,
    null,
  );
  check(
    'portal-search: "0 roles" is NOT a results line',
    realCount('0 roles across all departments', []).resultsText === false,
    null,
  );
  const csResume =
    'Customer service professional with member support experience. Customer Service Agent at Alorica, handling billing and service issues.';
  check('portal-search: term is the resume top-2 terms', jobsMod.portalSearchTerm(csResume) === 'service customer', jobsMod.portalSearchTerm(csResume));

  /* A fake Puppeteer page: evaluate is keyed on the in-page function's
   * name (scanSearchForm, countJobListings) and returns canned
   * descriptors; anonymous text-length polls return 1000.
   * evaluateHandle returns a stub element handle — input vs button is
   * told apart from the getter function's source. Enter presses and
   * button clicks fire the test's onEnter / onButtonClick hooks, which
   * simulate the portal navigating to its results page. */
  class FakePage {
    constructor(opts = {}) {
      this._url = opts.url || 'https://portal.example/careers';
      this.scanResult = opts.scanResult || { inputs: [], buttons: [], forms: [] };
      this.countQueue = [...(opts.counts || [])];
      this.onEnter = opts.onEnter || null;
      this.onButtonClick = opts.onButtonClick || null;
      this.gateScan = opts.gateScan || { controls: [] };
      this.onGateClick = opts.onGateClick || null;
      this.gateClicks = 0;
      this.gateLabels = [];
      this.onSelectPick = opts.onSelectPick || null;
      this.selectPicks = 0;
      this.selectLabels = [];
      this.failEnter = !!opts.failEnter;
      this.calls = [];
      this.typedTerms = [];
      this.pressedKeys = [];
      this.buttonClicks = 0;
      this.inputClicks = 0;
      this.currentTerm = '';
      const self = this;
      this.keyboard = {
        press: async (key) => {
          self.pressedKeys.push(key);
          if (key === 'Enter') {
            if (self.failEnter) throw new Error('Enter failed');
            if (self.onEnter) self.onEnter(self.currentTerm, self);
          }
        },
        down: async () => {},
        up: async () => {},
      };
    }
    url() {
      return this._url;
    }
    setUrl(u) {
      this._url = u;
    }
    async evaluate(fn, ...args) {
      const name = fn.name || 'anon';
      this.calls.push({ fn: name, args });
      if (name === 'scanSearchForm') return this.scanResult;
      if (name === 'countJobListings') {
        return this.countQueue.length > 0
          ? this.countQueue.shift()
          : { jobLinks: 0, resultsText: false };
      }
      if (name === 'scanGateControls') return this.gateScan;
      if (name === 'pickSelectOption') {
        const [selectIndex, optionIndex] = args;
        const sel = (this.gateScan.controls || []).find(
          (c) => c.kind === 'select' && c.index === selectIndex,
        );
        const label = sel?.options?.[optionIndex]?.text ?? '';
        this.selectPicks += 1;
        this.selectLabels.push(label);
        if (this.onSelectPick) this.onSelectPick(label, this);
        return true;
      }
      return 1000;
    }
    async evaluateHandle(fn, ...args) {
      const isGate = String(fn).includes('gateButtonElement');
      const isButton = String(fn).includes('button');
      this.calls.push({ fn: 'evaluateHandle:' + (isGate ? 'gate' : isButton ? 'button' : 'input'), args });
      const self = this;
      return {
        asElement: () => ({
          click: async () => {
            if (isGate) {
              const btns = (self.gateScan.controls || []).filter((c) => c.kind === 'button');
              const label = btns[args[0]]?.label ?? btns[args[0]]?.ariaLabel ?? '';
              self.buttonClicks += 1;
              self.gateClicks += 1;
              self.gateLabels.push(label);
              if (self.onGateClick) self.onGateClick(label, self);
            } else if (isButton) {
              self.buttonClicks += 1;
              if (self.onButtonClick) self.onButtonClick(self.currentTerm, self);
            } else {
              self.inputClicks += 1;
            }
          },
          type: async (text) => {
            self.typedTerms.push(text);
            self.currentTerm = text;
          },
          evaluate: async () => {},
        }),
        dispose: async () => {},
      };
    }
  }
  const portalScan = {
    inputs: [mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: 0 })],
    buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 })],
    forms: [{ action: '/jobs', method: 'get' }],
  };
  const runSearch = (page, term = 'customer service') =>
    searchMod.tryPortalSearch(page, term, Date.now() + 30000);

  // No form on the page: no crash, no submit.
  const noFormPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [{ jobLinks: 0, resultsText: false }],
  });
  check(
    'portal-search: no form, no crash',
    (await runSearch(noFormPage)) === 'no-form' && noFormPage.typedTerms.length === 0 && noFormPage.pressedKeys.length === 0,
    noFormPage.typedTerms,
  );
  // Board-action form: refused, never submitted — and the toggle
  // rescue never touches the board's submit button either.
  const boardFormPage = new FakePage({
    scanResult: { ...portalScan, forms: [{ action: 'https://boards.greenhouse.io/embed/job_board/js?for=x', method: 'get' }] },
    counts: [{ jobLinks: 0, resultsText: false }],
  });
  check(
    'portal-search: board form action never touched',
    (await runSearch(boardFormPage)) === 'no-form' && boardFormPage.typedTerms.length === 0 && boardFormPage.pressedKeys.length === 0 && boardFormPage.buttonClicks === 0,
    boardFormPage.typedTerms,
  );
  // Site-search form (WordPress ?s=): the box qualifies on its own
  // signals, but its action submits to the site root, not a jobs
  // page — refused like a board action, never submitted (Omni:
  // ?s=service+customer, no-results, on the wrong page). The toggle
  // rescue never touches its submit button either.
  const siteSearchPage = new FakePage({
    scanResult: { ...portalScan, forms: [{ action: '/', method: 'get' }] },
    counts: [{ jobLinks: 0, resultsText: false }],
  });
  check(
    'portal-search: site-search form action refused, never submitted',
    (await runSearch(siteSearchPage)) === 'no-form' && siteSearchPage.typedTerms.length === 0 && siteSearchPage.pressedKeys.length === 0 && siteSearchPage.buttonClicks === 0,
    siteSearchPage.typedTerms,
  );
  // The search box lives behind a "Search jobs" toggle: the first
  // scan finds no input, the toggle click reveals the box, the retry
  // submits and finds listings. One toggle click, one Enter.
  const togglePage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Search jobs', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }, { jobLinks: 5, resultsText: true }],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    onButtonClick: (term, page) => {
      page.scanResult = portalScan;
    },
  });
  const toggleOutcome = await runSearch(togglePage);
  check(
    'portal-search: toggle click reveals the box, retry finds listings',
    toggleOutcome === 'searched' &&
      togglePage.buttonClicks === 1 &&
      togglePage.typedTerms.length === 0 &&
      togglePage.pressedKeys.filter((k) => k === 'Enter').length === 1,
    { outcome: toggleOutcome, clicks: togglePage.buttonClicks, keys: togglePage.pressedKeys },
  );
  // A toggle that reveals nothing still reports no-form.
  const toggleDeadPage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Search jobs', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }],
  });
  check(
    'portal-search: dead toggle still reports no-form',
    (await runSearch(toggleDeadPage)) === 'no-form' && toggleDeadPage.buttonClicks === 1,
    toggleDeadPage.buttonClicks,
  );
  // The entry button can be a country picker, not a search box:
  // Foundever's portal gates its search behind "Find a job in your
  // country" (the form is display:none until a country is picked).
  // The toggle must fire on the singular "Find a job" phrasing.
  const countryTogglePage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Find a job in your country', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }, { jobLinks: 5, resultsText: true }],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    onButtonClick: (term, page) => {
      page.scanResult = portalScan;
    },
  });
  const countryToggleOutcome = await runSearch(countryTogglePage);
  check(
    'portal-search: "Find a job in your country" toggle fires and the retry finds listings',
    countryToggleOutcome === 'searched' && countryTogglePage.buttonClicks === 1,
    { outcome: countryToggleOutcome, clicks: countryTogglePage.buttonClicks },
  );
  // The toggle click is reported to the caller: the render's
  // attempt record must say the toggle fired (and which button),
  // not just that the search found no form. A toggle that reveals
  // nothing still reports its label.
  let reportedToggle = null;
  const reportPage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Find a job in your country', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }],
  });
  await searchMod.tryPortalSearch(reportPage, 'customer service', Date.now() + 30000, (label) => {
    reportedToggle = label;
  });
  check(
    'portal-search: the toggle click label is reported to the caller',
    reportedToggle === 'Find a job in your country' && reportPage.buttonClicks === 1,
    { reportedToggle, clicks: reportPage.buttonClicks },
  );
  // Gate-control makers for the generic resolver tests.
  const mkGateButton = (over) => ({
    kind: 'button',
    index: 0,
    label: '',
    ariaLabel: '',
    href: '',
    containerRole: '',
    containerClass: false,
    role: 'button',
    visible: true,
    options: [],
    ...over,
  });
  const mkGateOption = (over) => ({ index: 0, text: '', value: '', selected: false, ...over });
  const mkGateSelect = (over) => ({
    kind: 'select',
    index: 0,
    label: '',
    ariaLabel: '',
    href: '',
    containerRole: '',
    containerClass: false,
    role: 'select',
    visible: true,
    options: [],
    ...over,
  });
  // The toggle reveals a country picker modal, not a search box: the
  // retry still finds no form, the "United States (USA)" entry is
  // picked, the box appears, and the search finds listings. The
  // label carries the "(USA)" suffix the old exact-match finder
  // missed (round-11 canary: toggle fired, country never picked).
  // Foundever/Sitel live shape (15 inputs, 1 visible, bestScore 2
  // after the toggle). A job-title link in the same picker must
  // never be picked as a gate option.
  const pickerScan = {
    inputs: [],
    buttons: [mkButton({ index: 0, text: 'United States', type: 'button', formIndex: -1 })],
    forms: [],
  };
  const countryPickerScan = {
    controls: [
      mkGateButton({ index: 0, label: 'United States (USA)', containerRole: 'dialog' }),
      mkGateButton({ index: 1, label: 'Canada', containerRole: 'dialog' }),
      mkGateButton({ index: 2, label: 'Mexico', containerRole: 'dialog' }),
      mkGateButton({
        index: 3,
        label: 'Remote Customer Service Representative 1',
        href: '/go/Search-Jobs-US/9244800/',
        containerRole: 'dialog',
      }),
    ],
  };
  let reportedCountry = null;
  let reportedGate = null;
  const countryPage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Find a job in your country', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    onButtonClick: (term, page) => {
      page.scanResult = pickerScan;
    },
    gateScan: countryPickerScan,
    onGateClick: (label, page) => {
      // A real pick navigates away (or the picker closes): the option
      // is gone on the next scan, and the box is what appears.
      page.gateScan = { controls: [] };
      page.scanResult = portalScan;
    },
  });
  const countryOutcome = await searchMod.tryPortalSearch(
    countryPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    (label) => {
      reportedCountry = label;
    },
    (label) => {
      reportedGate = label;
    },
  );
  check(
    'portal-search: country picker modal pick ("United States (USA)") reveals the box and the search finds listings',
    countryOutcome === 'searched' &&
      countryPage.buttonClicks === 2 &&
      countryPage.gateClicks === 1 &&
      JSON.stringify(countryPage.gateLabels) === JSON.stringify(['United States (USA)']) &&
      reportedCountry === 'United States (USA)' &&
      reportedGate === 'United States (USA)',
    { outcome: countryOutcome, clicks: countryPage.buttonClicks, gateClicks: countryPage.gateClicks, gateLabels: countryPage.gateLabels, reportedCountry, reportedGate },
  );
  // No US entry in the picker: still no-form, no crash, nothing clicked.
  const noCountryPage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Find a job in your country', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }],
    onButtonClick: (term, page) => {
      page.scanResult = pickerScan;
    },
    gateScan: {
      controls: [
        mkGateButton({ index: 0, label: 'Canada', containerRole: 'dialog' }),
        mkGateButton({ index: 1, label: 'Mexico', containerRole: 'dialog' }),
      ],
    },
  });
  check(
    'portal-search: picker with no US entry still reports no-form',
    (await searchMod.tryPortalSearch(noCountryPage, 'customer service', Date.now() + 30000)) === 'no-form' &&
      noCountryPage.gateClicks === 0,
    { gateClicks: noCountryPage.gateClicks },
  );
  // The round-11 root cause, pinned directly: the picker's label
  // carries a suffix, and normalization must strip it.
  check(
    'gate-resolver: "United States (USA)" normalizes to "United States"',
    searchMod.normalizeGateLabel('United States (USA)') === 'United States' &&
      searchMod.normalizeGateLabel('Work from Home (US)') === 'Work from Home' &&
      searchMod.normalizeGateLabel('United States - English') === 'United States',
    searchMod.normalizeGateLabel('United States (USA)'),
  );
  // Results-count formats: Phenom's "Results 1 – 10 of 34" must
  // count as listings (round-12 canary: the range format was missed,
  // so the search submitted on the US results page and destroyed
  // the country context). A zero total never counts.
  check(
    'gate-resolver: results-count text recognizes range formats and rejects zeros',
    searchMod.hasResultsCountText('Results 1 – 10 of 34') === true &&
      searchMod.hasResultsCountText('Results 1 - 10 of 34') === true &&
      searchMod.hasResultsCountText('Showing 1-10 of 34 jobs') === true &&
      searchMod.hasResultsCountText('1-25 of 4,659 jobs') === true &&
      searchMod.hasResultsCountText('9 roles across all departments') === true &&
      searchMod.hasResultsCountText('Search results (0 jobs available)') === false &&
      searchMod.hasResultsCountText('Results 0 – 0 of 0') === false &&
      searchMod.hasResultsCountText('No jobs found') === false,
    null,
  );
  // US outranks remote when both options are visible at once.
  check(
    'gate-resolver: US pick outranks remote when both options are visible',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'Remote', containerRole: 'menu' }),
          mkGateButton({ index: 1, label: 'United States', containerRole: 'menu' }),
        ],
      },
      'customer service',
      true,
      'https://portal.example/careers',
    )?.label === 'United States',
    null,
  );
  // Bare locale links are pickable with no gate opened (Omni's
  // country list is bare footer links, no dropdown container, and
  // the old rule left them unpickable forever); bare 'Remote' and
  // bare role links are not, and a bare US link to another host is
  // not either (2026-11-12 local round). A job title is never
  // exactly "United States", which is what makes the bare locale
  // safe to pick.
  check(
    'gate-resolver: bare "United States" link is pickable with no gate opened',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'United States', href: 'https://portal.example/us-results' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.label === 'United States',
    null,
  );
  check(
    'gate-resolver: bare "English" link is pickable with no gate opened',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'English', href: 'https://portal.example/us-results' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.label === 'English',
    null,
  );
  check(
    'gate-resolver: bare "Remote" link is NOT pickable with no gate opened',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'Remote', href: 'https://portal.example/us-results' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/careers',
    ) === null,
    null,
  );
  check(
    'gate-resolver: bare role link ("Customer Service") is NOT pickable',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'Customer Service', href: 'https://portal.example/us-results' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/careers',
    ) === null,
    null,
  );
  check(
    'gate-resolver: bare US link to another host is NOT pickable',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'United States', href: 'https://other.example/us-results' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/careers',
    ) === null,
    null,
  );
  check(
    'gate-resolver: bare US button (no href) is pickable with no gate opened',
    searchMod.selectGateAction(
      { controls: [mkGateButton({ index: 0, label: 'United States' })] },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.label === 'United States',
    null,
  );
  // Region dropdown as a native <select>, visible on load with no
  // toggle at all: the US option is picked through the select, the
  // box appears, the search finds listings.
  const regionPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    gateScan: {
      controls: [
        mkGateSelect({
          index: 0,
          label: 'Region',
          options: [
            mkGateOption({ index: 0, text: 'Select a region', value: '', selected: true }),
            mkGateOption({ index: 1, text: 'United States', value: 'US' }),
            mkGateOption({ index: 2, text: 'Canada', value: 'CA' }),
            mkGateOption({ index: 3, text: 'Europe', value: 'EU' }),
          ],
        }),
      ],
    },
    onSelectPick: (label, page) => {
      page.gateScan = { controls: [] };
      page.scanResult = portalScan;
    },
  });
  const regionOutcome = await searchMod.tryPortalSearch(regionPage, 'customer service', Date.now() + 30000);
  check(
    'portal-search: region <select> pick ("United States") reveals the box and the search finds listings',
    regionOutcome === 'searched' &&
      regionPage.selectPicks === 1 &&
      JSON.stringify(regionPage.selectLabels) === JSON.stringify(['United States']) &&
      regionPage.gateClicks === 0,
    { outcome: regionOutcome, selectPicks: regionPage.selectPicks, selectLabels: regionPage.selectLabels },
  );
  // Department dropdown as a native <select>: the resume's role
  // term picks the matching department ("Customer Service"), the
  // box appears, the search finds listings. The placeholder option
  // (selected) is never picked.
  let reportedDeptGate = null;
  const deptPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    gateScan: {
      controls: [
        mkGateSelect({
          index: 0,
          label: 'Department',
          options: [
            mkGateOption({ index: 0, text: 'All departments', value: '', selected: true }),
            mkGateOption({ index: 1, text: 'Customer Service', value: 'cs' }),
            mkGateOption({ index: 2, text: 'Engineering', value: 'eng' }),
            mkGateOption({ index: 3, text: 'Sales', value: 'sales' }),
          ],
        }),
      ],
    },
    onSelectPick: (label, page) => {
      page.gateScan = { controls: [] };
      page.scanResult = portalScan;
    },
  });
  const deptOutcome = await searchMod.tryPortalSearch(
    deptPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    () => {},
    (label) => {
      reportedDeptGate = label;
    },
  );
  check(
    'portal-search: department <select> pick ("Customer Service") reveals the box and the search finds listings',
    deptOutcome === 'searched' &&
      deptPage.selectPicks === 1 &&
      JSON.stringify(deptPage.selectLabels) === JSON.stringify(['Customer Service']) &&
      reportedDeptGate === 'Customer Service',
    { outcome: deptOutcome, selectPicks: deptPage.selectPicks, selectLabels: deptPage.selectLabels, reportedDeptGate },
  );
  // Language selector in two steps: a "Language" opener button
  // reveals the language options, then "English" is picked, the
  // box appears, and the search finds listings.
  const langOptionsScan = {
    controls: [
      mkGateButton({ index: 0, label: 'English', containerRole: 'menu' }),
      mkGateButton({ index: 1, label: 'Deutsch', containerRole: 'menu' }),
      mkGateButton({ index: 2, label: 'Español', containerRole: 'menu' }),
    ],
  };
  const langPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
    gateScan: {
      controls: [mkGateButton({ index: 0, label: 'Language' })],
    },
    onGateClick: (label, page) => {
      if (page.gateClicks === 1) page.gateScan = langOptionsScan;
      else {
        page.gateScan = { controls: [] };
        page.scanResult = portalScan;
      }
    },
  });
  const langOutcome = await searchMod.tryPortalSearch(langPage, 'customer service', Date.now() + 30000);
  check(
    'portal-search: language selector opener then "English" pick reveals the box and the search finds listings',
    langOutcome === 'searched' &&
      langPage.gateClicks === 2 &&
      JSON.stringify(langPage.gateLabels) === JSON.stringify(['Language', 'English']),
    { outcome: langOutcome, gateClicks: langPage.gateClicks, gateLabels: langPage.gateLabels },
  );
  // A bare "United States" link that points at a job board is never
  // picked, even after a gate opened: same-host rule + board guard.
  const boardLinkPage = new FakePage({
    scanResult: {
      inputs: [],
      buttons: [mkButton({ index: 0, text: 'Find a job in your country', type: 'button', formIndex: -1 })],
      forms: [],
    },
    counts: [{ jobLinks: 0, resultsText: false }],
    onButtonClick: (term, page) => {
      page.scanResult = pickerScan;
    },
    gateScan: {
      controls: [
        mkGateButton({
          index: 0,
          label: 'United States',
          href: 'https://boards.greenhouse.io/embed/job_board/js?for=x',
        }),
      ],
    },
  });
  check(
    'portal-search: bare US link to a board is never picked',
    (await searchMod.tryPortalSearch(boardLinkPage, 'customer service', Date.now() + 30000)) === 'no-form' &&
      boardLinkPage.gateClicks === 0 &&
      boardLinkPage.buttonClicks === 1,
    { gateClicks: boardLinkPage.gateClicks, buttonClicks: boardLinkPage.buttonClicks },
  );
  // A pick that NAVIGATES to a listings page ends the search at
  // once: no submit on the destination page (an empty submit would
  // reset the context the pick just established — Foundever round
  // 12: the global /search/ page returned Budapest roles).
  const navListingsPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    gateScan: {
      controls: [mkGateButton({ index: 0, label: 'United States (USA)', containerRole: 'dialog' })],
    },
    onGateClick: (label, page) => {
      page.setUrl('https://portal.example/careers/us-results');
    },
  });
  check(
    'portal-search: navigating pick to a listings page ends the search with no submit',
    (await searchMod.tryPortalSearch(navListingsPage, 'customer service', Date.now() + 30000)) === 'searched' &&
      navListingsPage.gateClicks === 1 &&
      navListingsPage.typedTerms.length === 0 &&
      navListingsPage.pressedKeys.filter((k) => k === 'Enter').length === 0,
    { gateClicks: navListingsPage.gateClicks, typed: navListingsPage.typedTerms, keys: navListingsPage.pressedKeys },
  );
  // A pick that navigates to an EMPTY page still never submits:
  // the search ends no-form (the render loop retries the next
  // target), and no empty submit replaces the destination.
  const navEmptyPage = new FakePage({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
    ],
    gateScan: {
      controls: [mkGateButton({ index: 0, label: 'United States (USA)', containerRole: 'dialog' })],
    },
    onGateClick: (label, page) => {
      page.setUrl('https://portal.example/careers/us-results');
      page.scanResult = portalScan;
    },
  });
  check(
    'portal-search: navigating pick to an empty page ends no-form with no submit',
    (await searchMod.tryPortalSearch(navEmptyPage, 'customer service', Date.now() + 30000)) === 'no-form' &&
      navEmptyPage.gateClicks === 1 &&
      navEmptyPage.typedTerms.length === 0 &&
      navEmptyPage.pressedKeys.filter((k) => k === 'Enter').length === 0,
    { gateClicks: navEmptyPage.gateClicks, typed: navEmptyPage.typedTerms, keys: navEmptyPage.pressedKeys },
  );
  // Empty search yields listings: Enter alone submits, no term typed.
  const emptyWins = new FakePage({
    scanResult: portalScan,
    counts: [{ jobLinks: 0, resultsText: false }, { jobLinks: 5, resultsText: true }],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
  });
  check(
    'portal-search: empty search finds listings via Enter',
    (await runSearch(emptyWins)) === 'searched' &&
      emptyWins.typedTerms.length === 0 &&
      emptyWins.pressedKeys.filter((k) => k === 'Enter').length === 1,
    { typed: emptyWins.typedTerms, keys: emptyWins.pressedKeys },
  );
  // Empty search shows nothing, term search finds listings: the term
  // is typed with real keystrokes, then Enter.
  const termWins = new FakePage({
    scanResult: portalScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 4, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
  });
  check(
    'portal-search: term fallback typed, then Enter',
    (await runSearch(termWins)) === 'searched' &&
      JSON.stringify(termWins.typedTerms) === JSON.stringify(['customer service']) &&
      termWins.pressedKeys.filter((k) => k === 'Enter').length === 2,
    { typed: termWins.typedTerms, keys: termWins.pressedKeys },
  );
  // The full ladder runs (empty, resume term, "remote" — the
  // "customer service" rung is skipped because the resume term
  // already is that phrase), still nothing: no-results, no crash.
  const noResults = new FakePage({
    scanResult: portalScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
  });
  check(
    'portal-search: full ladder, still nothing, is no-results',
    (await runSearch(noResults)) === 'no-results' &&
      JSON.stringify(noResults.typedTerms) === JSON.stringify(['customer service', 'remote']) &&
      noResults.pressedKeys.filter((k) => k === 'Enter').length === 3,
    { typed: noResults.typedTerms, keys: noResults.pressedKeys },
  );
  // The "remote" rung unlocks a portal the resume term did not:
  // empty and "software engineer" show nothing, "remote" finds
  // listings — the "customer service" rung never runs. onEnter
  // navigates to a fresh URL per submit so waitForChange sees the
  // change at once (a fixed URL would burn the 8s button-fallback
  // wait on every repeat submit and starve the ladder's budget).
  let remoteN = 0;
  const remoteWins = new FakePage({
    scanResult: portalScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 4, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl(`https://portal.example/careers/results?n=${++remoteN}`),
  });
  check(
    'portal-search: remote rung finds listings the resume term missed',
    (await runSearch(remoteWins, 'software engineer')) === 'searched' &&
      JSON.stringify(remoteWins.typedTerms) === JSON.stringify(['software engineer', 'remote']) &&
      remoteWins.pressedKeys.filter((k) => k === 'Enter').length === 3,
    { typed: remoteWins.typedTerms, keys: remoteWins.pressedKeys },
  );
  // The "Remote" location fill unlocks a portal whose keyword
  // submits all showed nothing: the ladder runs dry, the location
  // box is filled with "Remote", and the last term re-submitted
  // finds listings. onEnter navigates to a fresh URL per submit
  // (see the "remote" test above) so the ladder + fill fit the
  // 30s budget instead of burning it on button-fallback waits.
  const locScan = {
    inputs: [
      mkInput({ index: 0, name: 'keyword', placeholder: 'Search by Keyword', formIndex: 0 }),
      mkInput({ index: 1, name: 'location', placeholder: 'City, State or Zip', formIndex: 0 }),
    ],
    buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 })],
    forms: [{ action: '/jobs', method: 'get' }],
  };
  let locN = 0;
  const locWins = new FakePage({
    scanResult: locScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 4, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl(`https://portal.example/careers/results?n=${++locN}`),
  });
  check(
    'portal-search: Remote location fill + last-term re-submit finds listings',
    (await runSearch(locWins)) === 'searched' &&
      JSON.stringify(locWins.typedTerms) ===
        JSON.stringify(['customer service', 'remote', 'Remote', 'remote']) &&
      locWins.pressedKeys.filter((k) => k === 'Enter').length === 4,
    { typed: locWins.typedTerms, keys: locWins.pressedKeys },
  );
  // The search box is the site's header search, not the portal's:
  // the empty submit strands the page on ?s= with no listings, and
  // the term retry is refused as site search — but the country gate
  // still stands behind the box. The gate is driven AFTER the
  // submits, never before a working term retry, and no submit ever
  // follows a pick (Omni: both live renders ended no-form with the
  // gate never driven, 2026-11-12 local round). Counts queue:
  // entry, after-empty-submit, then after the opener two checks
  // (listings + bare links), then after the navigating pick.
  const omniScan = {
    inputs: [mkInput({ index: 0, name: 's', type: 'search', placeholder: 'Search', formIndex: 0 })],
    buttons: [],
    forms: [{ action: '/', method: 'get' }],
  };
  const omniMenuScan = {
    controls: [
      mkGateButton({ index: 0, label: 'United States', containerRole: 'menu' }),
      mkGateButton({ index: 1, label: 'Puerto Rico', containerRole: 'menu' }),
      mkGateButton({ index: 2, label: 'Guatemala', containerRole: 'menu' }),
    ],
  };
  let reportedOmniCountry = null;
  const omniPage = new FakePage({
    url: 'https://portal.example/',
    scanResult: omniScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/?s='),
    gateScan: {
      controls: [mkGateButton({ index: 0, label: 'Select your country' })],
    },
    onGateClick: (label, page) => {
      if (label === 'Select your country') page.gateScan = omniMenuScan;
      else {
        page.setUrl('https://portal.example/us-results');
        page.gateScan = { controls: [] };
      }
    },
  });
  const omniOutcome = await searchMod.tryPortalSearch(
    omniPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    (label) => {
      reportedOmniCountry = label;
    },
    () => {},
  );
  check(
    'portal-search: post-submit gate — opener then US pick after the site search strands the page',
    omniOutcome === 'searched' &&
      omniPage.gateClicks === 2 &&
      JSON.stringify(omniPage.gateLabels) === JSON.stringify(['Select your country', 'United States']) &&
      reportedOmniCountry === 'United States' &&
      omniPage.pressedKeys.filter((k) => k === 'Enter').length === 1 &&
      omniPage.typedTerms.length === 0,
    { outcome: omniOutcome, gateClicks: omniPage.gateClicks, gateLabels: omniPage.gateLabels, reportedOmniCountry, keys: omniPage.pressedKeys, typed: omniPage.typedTerms },
  );
  // Same stranded site search, but the country gate is bare footer
  // links — no dropdown container, no gate opened yet. A bare
  // "United States" link is pickable (a job title is never exactly
  // "United States"), so the gate still drives after the submits.
  let reportedBareCountry = null;
  const bareLinkPage = new FakePage({
    url: 'https://portal.example/',
    scanResult: omniScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/?s='),
    gateScan: {
      controls: [
        mkGateButton({ index: 0, label: 'United States', href: 'https://portal.example/us-results' }),
        mkGateButton({ index: 1, label: 'Puerto Rico', href: 'https://portal.example/pr-results' }),
      ],
    },
    onGateClick: (label, page) => {
      page.setUrl('https://portal.example/us-results');
      page.gateScan = { controls: [] };
    },
  });
  const bareOutcome = await searchMod.tryPortalSearch(
    bareLinkPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    (label) => {
      reportedBareCountry = label;
    },
    () => {},
  );
  check(
    'portal-search: post-submit gate — bare "United States" footer link drives after the site search strands the page',
    bareOutcome === 'searched' &&
      bareLinkPage.gateClicks === 1 &&
      JSON.stringify(bareLinkPage.gateLabels) === JSON.stringify(['United States']) &&
      reportedBareCountry === 'United States' &&
      bareLinkPage.pressedKeys.filter((k) => k === 'Enter').length === 1,
    { outcome: bareOutcome, gateClicks: bareLinkPage.gateClicks, gateLabels: bareLinkPage.gateLabels, reportedBareCountry, keys: bareLinkPage.pressedKeys },
  );
  // Both submits stranded, gate scan empty: the search outcome
  // stands — no-form when the term retry found no box, and the gate
  // helper returns null without touching anything.
  const strandedPage = new FakePage({
    url: 'https://portal.example/',
    scanResult: omniScan,
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
    ],
    onEnter: (term, page) => page.setUrl('https://portal.example/?s='),
    gateScan: { controls: [] },
  });
  check(
    'portal-search: post-submit with no gate falls through to no-form',
    (await runSearch(strandedPage)) === 'no-form' &&
      strandedPage.gateClicks === 0 &&
      strandedPage.pressedKeys.filter((k) => k === 'Enter').length === 1,
    { gateClicks: strandedPage.gateClicks, keys: strandedPage.pressedKeys },
  );
  // The gate opener IS the link to the portal: it navigates, and the
  // portal's own "Find a job in your country" button is a legitimate
  // opener on the fresh page — not a re-click of the one that just
  // fired. The exclusion is about the page the gate opened on, so
  // gateOpened resets when the URL changes (Sitel: the first local
  // round burned a second render on exactly this, 2026-11-12).
  const sitelPortalScan = {
    controls: [mkGateButton({ index: 0, label: 'Find a job in your country' })],
  };
  const sitelPickerScan = {
    controls: [
      mkGateButton({ index: 0, label: 'United States (USA)', containerRole: 'dialog' }),
      mkGateButton({ index: 1, label: 'Canada', containerRole: 'dialog' }),
      mkGateButton({ index: 2, label: 'Mexico', containerRole: 'dialog' }),
    ],
  };
  let reportedSitelCountry = null;
  const sitelPage = new FakePage({
    url: 'https://portal.example/',
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    gateScan: {
      controls: [
        mkGateButton({ index: 0, label: 'Find a job in your country', href: 'https://portal.example/jobs-portal' }),
      ],
    },
    onGateClick: (label, page) => {
      if (page.url() === 'https://portal.example/') {
        page.setUrl('https://portal.example/jobs-portal');
        page.gateScan = sitelPortalScan;
      } else if (page.gateClicks === 2) {
        page.gateScan = sitelPickerScan;
      } else {
        page.setUrl('https://portal.example/us-results');
        page.gateScan = { controls: [] };
      }
    },
  });
  const sitelOutcome = await searchMod.tryPortalSearch(
    sitelPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    (label) => {
      reportedSitelCountry = label;
    },
    () => {},
  );
  check(
    'portal-search: gate opener that navigates resets the exclusion — the portal’s own "Find a job in your country" opens',
    sitelOutcome === 'searched' &&
      sitelPage.gateClicks === 3 &&
      JSON.stringify(sitelPage.gateLabels) ===
        JSON.stringify(['Find a job in your country', 'Find a job in your country', 'United States (USA)']) &&
      reportedSitelCountry === 'United States (USA)',
    { outcome: sitelOutcome, gateClicks: sitelPage.gateClicks, gateLabels: sitelPage.gateLabels, reportedSitelCountry },
  );
  // Page already lists jobs: no search at all.
  const alreadyListed = new FakePage({
    scanResult: portalScan,
    counts: [{ jobLinks: 6, resultsText: true }],
  });
  check(
    'portal-search: page already listing skips the search',
    (await runSearch(alreadyListed)) === 'has-listings' && alreadyListed.typedTerms.length === 0 && alreadyListed.pressedKeys.length === 0,
    alreadyListed.typedTerms,
  );
  // Submit fails: reported, no crash.
  const submitFails = new FakePage({
    scanResult: portalScan,
    counts: [{ jobLinks: 0, resultsText: false }],
    failEnter: true,
  });
  check(
    'portal-search: failed submit reported, no crash',
    (await runSearch(submitFails)) === 'submit-failed',
    null,
  );
  // No button: Enter alone submits, no click anywhere.
  const enterPage = new FakePage({
    scanResult: { ...portalScan, buttons: [] },
    counts: [{ jobLinks: 0, resultsText: false }, { jobLinks: 5, resultsText: true }],
    onEnter: (term, page) => page.setUrl('https://portal.example/careers/results'),
  });
  const enterOutcome = await runSearch(enterPage);
  check(
    'portal-search: no button, Enter alone submits',
    enterOutcome === 'searched' &&
      enterPage.pressedKeys.includes('Enter') &&
      enterPage.buttonClicks === 0,
    { outcome: enterOutcome, keys: enterPage.pressedKeys, clicks: enterPage.buttonClicks },
  );
  // Enter changes nothing, the submit button does: the click fallback.
  const clickFallback = new FakePage({
    scanResult: portalScan,
    counts: [{ jobLinks: 0, resultsText: false }, { jobLinks: 5, resultsText: true }],
    onEnter: null,
    onButtonClick: (term, page) => page.setUrl('https://portal.example/careers/results'),
  });
  const clickOutcome = await runSearch(clickFallback);
  check(
    'portal-search: silent Enter falls back to the button click',
    clickOutcome === 'searched' &&
      clickFallback.pressedKeys.includes('Enter') &&
      clickFallback.buttonClicks === 1,
    { outcome: clickOutcome, keys: clickFallback.pressedKeys, clicks: clickFallback.buttonClicks },
  );
  // Submit navigates onto a board: redirect reported, never parsed.
  const boardRedirect = new FakePage({
    scanResult: portalScan,
    counts: [{ jobLinks: 0, resultsText: false }],
    onEnter: (term, page) => page.setUrl('https://boards.greenhouse.io/portal/jobs'),
  });
  check(
    'portal-search: board redirect after submit reported',
    (await runSearch(boardRedirect)) === 'board-redirect',
    null,
  );
  // Not enough time left: skipped, nothing touched.
  const noTime = new FakePage({ scanResult: portalScan, counts: [{ jobLinks: 0, resultsText: false }] });
  check(
    'portal-search: skipped when the render budget is nearly gone',
    (await searchMod.tryPortalSearch(noTime, 'customer service', Date.now() + 1000)) === 'skipped-time' &&
      noTime.calls.length === 0,
    noTime.calls,
  );

  // --- Wiring: find-jobs passes the resume term to the renderer ---
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'Portal Co', website: 'https://portal.example', domain: 'portal.example', nameKey: 'portal co', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  const shellHtml = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
  const searchedHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => shellHtml });
  const resumeText =
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const seenTerms = [];
  const stubRender = async (url, term) => {
    seenTerms.push(term);
    return { html: searchedHtml, searchOutcome: 'searched', searchMs: 50, renderedUrl: url };
  };
  const out = await jobsMod.runFindJobs(
    { companiesCol },
    { resumeText, cursor: 0, limit: 15 },
    { renderPage: stubRender },
  );
  check(
    'portal-search: renderer receives the resume term',
    seenTerms.length === 1 && seenTerms[0] === jobsMod.portalSearchTerm(resumeText),
    seenTerms,
  );
  check(
    'portal-search: post-search listings extracted and scored',
    out.leads.length === 1 &&
      out.leads[0]?.title === 'Customer Support Specialist' &&
      out.leads[0]?.sourceType === 'rendered',
    out.leads,
  );
  check('portal-search: render stats count the searched company', out.stats.rendered === 1, out.stats);
}

async function testDeferredRender() {
  // Deferred rendering: the plain-HTML walk finishes FIRST and the
  // single per-company render goes to the most promising zero-yielding
  // candidate — a search/results URL — not the first zero-yielding
  // page the walk hits (Concentrix: /united-states/ is an FAQ page
  // with no search box; /job-search/ is the portal).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  check(
    'deferred-render: search/results URL outscores the FAQ page',
    jobsMod.renderTargetScore('https://jobs.concentrix.com/job-search/', 'https://careers.concentrix.com/united-states/') === 7 &&
      jobsMod.renderTargetScore('https://careers.concentrix.com/united-states/', 'https://careers.concentrix.com/united-states/') === 2,
    null,
  );
  check(
    'deferred-render: /careers still beats /jobs on a tie (walk order)',
    jobsMod.renderTargetScore('https://jsboard.example/careers', '') === 2 &&
      jobsMod.renderTargetScore('https://jsboard.example/jobs', '') === 2,
    null,
  );
  check(
    'deferred-render: user-given careers link beats a guessed sibling',
    // A jobs-subdomain homepage IS the portal (8 = 6 homepage + 2
    // user-given), so it outscores the /careers guess (2) on the
    // same host — the guess is a path that usually 404s or
    // redirects, the homepage is the search itself.
    jobsMod.renderTargetScore('https://jobs.cvshealth.com/', 'https://jobs.cvshealth.com/') === 8 &&
      jobsMod.renderTargetScore('https://jobs.cvshealth.com/careers', 'https://jobs.cvshealth.com/') === 2,
    null,
  );
  const faqHtml = `<html><body><h1>Life at Concentrix</h1><nav><a href="https://jobs.concentrix.com/job-search/">Search &amp; Apply</a></nav><p>No jobs on this page.</p></body></html>`;
  const portalShell = `<html><body><div id="root"></div><p>Search results (0 jobs available)</p></body></html>`;
  const searchedHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/job/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://careers.concentrix.com/united-states/') return { ok: true, text: async () => faqHtml };
    if (u === 'https://jobs.concentrix.com/job-search/') return { ok: true, text: async () => portalShell };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const resumeText =
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const renderedUrls = [];
  const stubRender = async (url) => {
    renderedUrls.push(url);
    return { html: searchedHtml, searchOutcome: 'searched', searchMs: 4200, renderedUrl: `${url}?searchQuery=service+customer` };
  };
  const out = await jobsMod.searchCompanyJobs(
    { name: 'Concentrix', website: 'https://careers.concentrix.com', careersUrl: 'https://careers.concentrix.com/united-states/', isUSCompany: true },
    resumeText,
    { renderPage: stubRender },
  );
  check(
    'deferred-render: the ONE render goes to /job-search/, not the FAQ page',
    renderedUrls.length === 1 && renderedUrls[0] === 'https://jobs.concentrix.com/job-search/',
    renderedUrls,
  );
  check(
    'deferred-render: the walk still tried the FAQ page first',
    out.triedUrls[0] === 'https://careers.concentrix.com/united-states/' &&
      out.triedUrls.includes('https://jobs.concentrix.com/job-search/'),
    out.triedUrls,
  );
  check(
    'deferred-render: post-search listings extracted, source is the rendered page',
    out.leads.length === 1 && out.sourcePage === 'https://jobs.concentrix.com/job-search/' && out.renderUsed === true,
    out,
  );
  check(
    'deferred-render: outcome + ms + final URL surface on the result',
    out.searchOutcome === 'searched' && out.searchMs === 4200 && out.renderedUrl === 'https://jobs.concentrix.com/job-search/?searchQuery=service+customer',
    { searchOutcome: out.searchOutcome, searchMs: out.searchMs, renderedUrl: out.renderedUrl },
  );
  // A portal-direct call (careersUrl IS the /job-search/ page) renders
  // that page itself — no detour through a sibling.
  const direct = await jobsMod.searchCompanyJobs(
    { name: 'Concentrix', website: '', careersUrl: 'https://jobs.concentrix.com/job-search/', isUSCompany: true },
    resumeText,
    { renderPage: stubRender },
  );
  check(
    'deferred-render: portal-direct renders the portal URL itself',
    renderedUrls[renderedUrls.length - 1] === 'https://jobs.concentrix.com/job-search/' && direct.leads.length === 1,
    renderedUrls,
  );
}

async function testRenderTargetScoring() {
  // Round-2 target scoring (2026-11-11 canary): the ATS-host bonus,
  // the jobs-subdomain-homepage rule, and the detail-link signal in
  // portal content — each hole in the 14-employer pass traces to
  // one of these three.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  // ATS bonus: the employer's real portal outscores a same-host
  // marketing page. Board hosts never earn it.
  check(
    'target-scoring: ATS hosts earn +8, other hosts 0',
    jobsMod.atsHostBonus('https://ats.rippling.com/liveops/jobs') === 8 &&
      jobsMod.atsHostBonus('https://modsquad.wd5.myworkdayjobs.com/en-US/ModSquad') === 8 &&
      jobsMod.atsHostBonus('https://recruiting.paylocity.com/recruiting/jobs/All/73b38a10/NexRep-LLC') === 8 &&
      jobsMod.atsHostBonus('https://alorica-hire.bling-ai.com/alorica/career') === 8 &&
      jobsMod.atsHostBonus('https://jobs.concentrix.com/job-search/') === 0 &&
      jobsMod.atsHostBonus('https://boards.greenhouse.io/datagrail/jobs/7982580003') === 0,
    null,
  );
  // The ATS bonus flips the actual canary losers: Rippling 11 vs
  // Liveops marketing 5, Workday 11 vs ModSquad join-page 10. The
  // comparison must include the marketing page's content score — the
  // old version compared renderTargetScore + host bonus only (9 vs
  // 5) and passed while the live walk scored the join page 10
  // (2 path + 5 content + 3 host) and the portal 9 (6 + 0 + 3),
  // so the portal lost by one and the retry never reached it
  // (2026-11-12 canary). At +8 the portal clears the marketing
  // page outright (8 + 0 + 3 = 11 > 10).
  const joinTwoDetail = `<html><body>
<a href="/en/job/las-vegas/customer-service-representative/44028/103182764528">Customer Service Representative</a>
<a href="/en/job/athens/dutch-customer-service/44028/103179030912">Dutch - Customer Service</a>
</body></html>`;
  check(
    'target-scoring: ATS portal beats the marketing page that won the canary',
    jobsMod.renderTargetScore('https://ats.rippling.com/liveops/jobs', '') + jobsMod.companyHostBonus('https://ats.rippling.com/liveops/jobs', 'Liveops') >
      jobsMod.renderTargetScore('https://liveops.com/about-us/careers/', '') + jobsMod.companyHostBonus('https://liveops.com/about-us/careers/', 'Liveops') &&
      jobsMod.renderTargetScore('https://modsquad.wd5.myworkdayjobs.com/en-US/ModSquad', '') + jobsMod.portalContentScore('<html><body><div id="root"></div></body></html>') + jobsMod.companyHostBonus('https://modsquad.wd5.myworkdayjobs.com/en-US/ModSquad', 'ModSquad') >
      jobsMod.renderTargetScore('https://join.modsquad.com/careers/', '') + jobsMod.portalContentScore(joinTwoDetail) + jobsMod.companyHostBonus('https://join.modsquad.com/careers/', 'ModSquad'),
    null,
  );
  // Jobs-subdomain homepage: Teleperformance's homepage (6) outranks
  // the /careers guess (2) on the same host.
  check(
    'target-scoring: jobs-subdomain homepage outranks the /careers guess',
    jobsMod.renderTargetScore('https://jobs.teleperformance.com', '') === 6 &&
      jobsMod.renderTargetScore('https://jobs.teleperformance.com/careers', '') === 2 &&
      jobsMod.renderTargetScore('https://jobs.teleperformance.com/jobs', '') === 2,
    null,
  );
  // Detail-link signal: two job-detail links make the page portal-like.
  const twoDetail = `<html><body>
<a href="/en/job/las-vegas/customer-service-representative/44028/103182764528">Customer Service Representative</a>
<a href="/en/job/athens/dutch-customer-service/44028/103179030912">Dutch - Customer Service</a>
</body></html>`;
  const oneDetail = `<html><body>
<a href="/en/job/las-vegas/customer-service-representative/44028/103182764528">Customer Service Representative</a>
<a href="/en/customer-service">Customer service jobs</a>
</body></html>`;
  const junkLinks = `<html><body>
<a href="/en/customer-service">Customer service jobs</a>
<a href="/en/sales">Sales jobs</a>
<a href="/en/work-from-home">Work from home jobs</a>
</body></html>`;
  check(
    'target-scoring: two job-detail links score +5, one or none scores 0',
    jobsMod.portalContentScore(twoDetail) === 5 &&
      jobsMod.portalContentScore(oneDetail) === 0 &&
      jobsMod.portalContentScore(junkLinks) === 0,
    null,
  );
  // Href entity decoding: two spellings of one link (Foundever's
  // &amp; / &#038; UTM variants) dedupe to a single candidate.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://found.example') {
      return {
        ok: true,
        text: async () =>
          `<html><body><a href="https://jobs.found.example/?utm_source=x&amp;utm_medium=y">Jobs</a><a href="https://jobs.found.example/?utm_source=x&#038;utm_medium=y">Jobs</a><a href="/careers">Careers</a></body></html>`,
      };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const found = await jobsMod.searchCompanyJobs(
    { name: 'Found Co', website: 'https://found.example', careersUrl: '', isUSCompany: true },
    'Customer support specialist',
  );
  check(
    'target-scoring: entity-variant links dedupe to one tried URL',
    found.triedUrls.filter((t) => t.startsWith('https://jobs.found.example/')).length === 1,
    found.triedUrls,
  );
  // Non-English locale param: the de_DE variant loses 4, en_US keeps 6.
  check(
    'target-scoring: non-English locale variant penalized, en_US kept',
    jobsMod.renderTargetScore('https://jobs.foundever.com/?utm_source=x&locale=de_DE', '') === 2 &&
      jobsMod.renderTargetScore('https://jobs.foundever.com/?utm_source=x&locale=en_US', '') === 6 &&
      jobsMod.renderTargetScore('https://jobs.foundever.com/?utm_source=x&locale=es_ES', '') === 2,
    null,
  );
  // ATS eligibility: a Workday URL whose path has no job word is
  // still a render candidate by host alone (ModSquad, 2026-11-12) —
  // without this the ATS bonus never fires, because the page is
  // never a candidate.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://mod.example') {
      return {
        ok: true,
        text: async () =>
          `<html><body><a href="https://mod.wd5.myworkdayjobs.com/en-US/ModSquad">Careers</a></body></html>`,
      };
    }
    return { ok: true, text: async () => '<html><body><div id="root"></div></body></html>' };
  };
  const workdayRendered = [];
  const workdayStub = async (url) => {
    workdayRendered.push(url);
    return { html: `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`, searchOutcome: 'searched', searchMs: 200, renderedUrl: url };
  };
  const workday = await jobsMod.searchCompanyJobs(
    { name: 'ModSquad', website: 'https://mod.example', careersUrl: '', isUSCompany: true },
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers',
    { renderPage: workdayStub },
  );
  check(
    'target-scoring: Workday URL renders by ATS host alone, finds the role',
    workdayRendered.length === 1 &&
      workdayRendered[0] === 'https://mod.wd5.myworkdayjobs.com/en-US/ModSquad' &&
      workday.leads.length === 1,
    { rendered: workdayRendered, leads: workday.leads },
  );
}

async function testRenderRetry() {
  // A no-form or dead first render retries the next-best target
  // instead of spending the company on the wrong page (Sitel,
  // Teleperformance, 2026-11-11 canary). Any other outcome stops.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText = 'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const shellHtml = '<html><body><div id="root"></div></body></html>';
  const listedHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => shellHtml });
  const mkNoForm = (url) => ({ html: '', searchOutcome: 'no-form', searchMs: 100, renderedUrl: url, searchScan: { inputs: 0, visibleInputs: 0, bestScore: 0, buttons: 0 } });
  // No-form on the /careers guess, listings on the /jobs guess.
  let calls = [];
  const stubRetry = async (url) => {
    calls.push(url);
    if (calls.length === 1) return mkNoForm(url);
    return { html: listedHtml, searchOutcome: 'searched', searchMs: 200, renderedUrl: url };
  };
  const retried = await jobsMod.searchCompanyJobs(
    { name: 'Retry Co', website: 'https://retry.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubRetry },
  );
  check(
    'render-retry: no-form retries the next target and finds the role',
    calls.length === 2 && calls[1] === 'https://retry.example/jobs' && retried.leads.length === 1 && retried.renderUsed === true && retried.searchOutcome === 'searched',
    { calls, leads: retried.leads, searchOutcome: retried.searchOutcome },
  );
  check(
    'render-retry: every attempt is recorded in order, with the sorted targets',
    retried.renderAttempts.length === 2 &&
      retried.renderAttempts[0]?.target === 'https://retry.example/careers' &&
      retried.renderAttempts[0]?.outcome === 'no-form' &&
      retried.renderAttempts[1]?.target === 'https://retry.example/jobs' &&
      retried.renderAttempts[1]?.outcome === 'searched' &&
      retried.renderTargets.length === 2 &&
      retried.renderTargets[0]?.url === 'https://retry.example/careers' &&
      retried.renderTargets[0]?.score === 2,
    { attempts: retried.renderAttempts, targets: retried.renderTargets },
  );
  // A null render retries too.
  calls = [];
  const stubNull = async (url) => {
    calls.push(url);
    if (calls.length === 1) return null;
    return { html: listedHtml, searchOutcome: 'searched', searchMs: 200, renderedUrl: url };
  };
  const nullRetried = await jobsMod.searchCompanyJobs(
    { name: 'Retry Co', website: 'https://retry.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubNull },
  );
  check(
    'render-retry: null render retries the next target',
    calls.length === 2 && nullRetried.leads.length === 1,
    { calls, leads: nullRetried.leads },
  );
  // No-results stops after one render.
  calls = [];
  const stubNoResults = async (url) => {
    calls.push(url);
    return { html: shellHtml, searchOutcome: 'no-results', searchMs: 200, renderedUrl: url };
  };
  const stopped = await jobsMod.searchCompanyJobs(
    { name: 'Retry Co', website: 'https://retry.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubNoResults },
  );
  check(
    'render-retry: no-results stops after the first render',
    calls.length === 1 && stopped.searchOutcome === 'no-results' && stopped.leads.length === 0,
    { calls, searchOutcome: stopped.searchOutcome },
  );
  // Budget max 1 means no retry even on no-form.
  calls = [];
  const capped = await jobsMod.searchCompanyJobs(
    { name: 'Retry Co', website: 'https://retry.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubRetry, renderBudget: { used: 0, max: 1 } },
  );
  check(
    'render-retry: budget max 1 means no retry',
    calls.length === 1 && capped.leads.length === 0 && capped.searchOutcome === 'no-form',
    { calls, searchOutcome: capped.searchOutcome },
  );
}

async function testRejectedTelemetry() {
  // A "4 postings, 0 leads" result must say WHICH titles died and
  // why — NexRep, 2026-11-12 (4 Paylocity postings, all
  // rejectedNoMatch, titles invisible in the response).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const out = jobsMod.screenPostings(
    'Test Co',
    [
      { title: 'Loan Analyst', location: 'Remote', url: 'https://example.com/jobs/loan-analyst', description: '', postedDate: '' },
      { title: 'Customer Support Specialist', location: 'Remote', url: 'https://example.com/jobs/support-specialist', description: '', postedDate: '' },
    ],
    'Customer support specialist with Zendesk experience',
    true,
  );
  check(
    'rejected-telemetry: no-match title rides the screened result',
    out.rejectedNoMatch === 1 &&
      out.leads.length === 1 &&
      out.rejected.length === 1 &&
      out.rejected[0]?.title === 'Loan Analyst' &&
      out.rejected[0]?.reason === 'no-match',
    out.rejected,
  );
  // The rejected list caps at 10.
  const many = Array.from({ length: 12 }, (_, i) => ({
    title: `Loan Analyst ${i}`, location: 'Remote', url: `https://example.com/jobs/loan-${i}`, description: '', postedDate: '',
  }));
  check(
    'rejected-telemetry: rejected list caps at 10',
    jobsMod.screenPostings('Test Co', many, 'Customer support specialist', true).rejected.length === 10,
    null,
  );
}

async function testJobCardAnchors() {
  // Strategy C: portals whose job list is <a class="...job-card...">
  // cards wrapping an <h3> title (Concentrix JDQ). Strategy A's
  // splitter shatters these — it fires on the card AND on every inner
  // element whose class mentions "job" (title, description, meta) —
  // so the card fragment keeps the href but no heading, the heading
  // fragment keeps the title but no link, and both are skipped.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const cardHtml = `<html><body><div class="jdq-jobs-container">
<a class="jdq-job-card" data-jdq-job-detail-base-url="/job/?id=R1781395" href="/job/?id=R1781395"><div class="jdq-tag">Analytics</div><h3 class="jdq-job-title">BI Functional Analyst</h3><p class="jdq-job-description">Short description here.</p><div class="jdq-job-meta"><div class="jdq-meta-item"><span>Denver, Colorado, United States of America</span></div></div></a>
<a class="jdq-job-card" href="/job/?id=R1780901"><h3 class="jdq-job-title">Customer Support Specialist</h3><p class="jdq-job-description">Support our customers.</p><div class="jdq-job-meta"><div class="jdq-meta-item"><span>Remote</span></div></div></a>
<a class="jdq-job-card" href="/job/?id=R1779018"><h3 class="jdq-job-title">Director, IT Service Delivery Management (TCF)</h3></a>
</div></body></html>`;
  const out = jobsMod.parseCareersPage(cardHtml, 'https://jobs.concentrix.com/job-search/');
  check(
    'job-cards: all 3 JDQ cards extracted with titles + apply links',
    out.length === 3 &&
      out[0]?.title === 'BI Functional Analyst' &&
      out[0]?.url === 'https://jobs.concentrix.com/job/?id=R1781395' &&
      out[1]?.title === 'Customer Support Specialist' &&
      out[2]?.title === 'Director, IT Service Delivery Management (TCF)',
    out,
  );
  check(
    'job-cards: Remote in the card text is read as the location',
    out[1]?.location === 'Remote',
    out[1],
  );
  // A card anchor with no heading inside is not a listing, and a nav
  // anchor with a job-ish class is not a listing either.
  const noHeading = `<html><body><a class="jdq-job-card" href="/job/?id=X1"><p class="jdq-job-description">No title here.</p></a><nav><a class="job-link" href="/jobs">Jobs</a></nav></body></html>`;
  check(
    'job-cards: heading-less card anchors and nav links are skipped',
    jobsMod.parseCareersPage(noHeading, 'https://jobs.concentrix.com/job-search/').length === 0,
    null,
  );
  // A traditional job block on the same page is still found once (the
  // card strategy and Strategy A dedupe on title+url, never double).
  const mixed = `<html><body><div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div></body></html>`;
  const mixedOut = jobsMod.parseCareersPage(mixed, 'https://portal.example/careers');
  check(
    'job-cards: traditional blocks still extract exactly once',
    mixedOut.length === 1 && mixedOut[0]?.title === 'Customer Support Specialist',
    mixedOut,
  );
}

async function testRealPostingGate() {
  // The junk-posting gate (v4 diagnosis, 2026-11-11): the parser used
  // to accept nav/category/CTA links as postings, so a junk-only
  // homepage 'found' postings and the walk returned early — render
  // and search never ran. A real posting is a specific role title AND
  // a job-detail link; either half failing drops the listing.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const { isJunkTitle, isJobDetailUrl, isRealPosting } = jobsMod;
  // Proven junk from the live homepages (TTEC, Working Solutions,
  // Foundever, Liveops, Kelly, NexRep, Sutherland, 2026-11-11).
  const junk = [
    ['Customer service jobs', 'https://www.ttecjobs.com/en/customer-service'],
    ['Sales jobs', 'https://www.ttecjobs.com/en/sales'],
    ['Work from home jobs', 'https://www.ttecjobs.com/en/work-from-home'],
    ['Corporate jobs', 'https://www.ttecjobs.com/en/corporate'],
    ['Technology jobs', 'https://www.ttecjobs.com/en/technology'],
    ['Licensed insurance agents careers', 'https://www.ttecjobs.com/en/licensed-insurance'],
    ['Jobs for veterans & military spouses', 'https://www.ttecjobs.com/en/veterans'],
    ['Jobs for interns & recent grads', 'https://www.ttecjobs.com/en/interns'],
    ['Join Our Talent Community', 'https://www.ttec.com/why-ttec'],
    ['OUR EMPLOYEES SAY IT BEST', 'https://www.ttecjobs.com/en/privacy'],
    ['Driven by values. United by culture.', 'https://www.ttecjobs.com/en/who-we-are'],
    ['Ready to Build Better Customer Operations?', 'https://jobs.workingsolutions.com/'],
    ['Apply Today', 'https://jobs.workingsolutions.com/'],
    ['Jobs near you', 'https://jobs.foundever.com/'],
    ['Become an agent', 'https://ats.rippling.com/liveops/jobs'],
    ['Looking for your next opportunity?', 'https://www.kellyservices.com/find-a-job/'],
    ['Current Career Opportunities', 'https://secure.saashr.com/ta/6164834.careers?ShowJobId=1'],
    ['Cookies Preferences', 'https://www.jobs.sutherlandglobal.com/cookie-preferences'],
  ];
  check(
    'gate: every proven junk title+url pair is dropped',
    junk.every(([t, u]) => isRealPosting(t, u) === false),
    junk.filter(([t, u]) => isRealPosting(t, u) !== false),
  );
  // Real postings from the same round of live checks survive.
  const real = [
    ['REMOTE CALL CENTER REPRESENTATIVE – WORK FROM HOME', 'https://www.ariseworkfromhome.com/program/remote-call-center-representative-work-from-home-47/'],
    ['Customer Support Advisor - Evenings', 'https://jobs.concentrix.com/job/?id=2141102703'],
    ['BI Functional Analyst', 'https://jobs.concentrix.com/job/?id=R1781395'],
    ['Frontend Developer', 'https://rawco.example/jobs/frontend-developer'],
    ['Customer Support Specialist', 'https://portal.example/jobs/support-specialist'],
    ['Pharmacy Technician / Care Coordinator', 'https://houserx.example/career-details'],
    ['Senior Product Designer', 'https://example.com/open-roles/senior-product-designer-remote'],
    ['Customer Success Manager', 'https://job-boards.greenhouse.io/datagrail/jobs/7982580003'],
  ];
  check(
    'gate: every proven real title+url pair survives',
    real.every(([t, u]) => isRealPosting(t, u) === true),
    real.filter(([t, u]) => isRealPosting(t, u) !== true),
  );
  // URL-shape edges: a category slug stops at three hyphenated
  // words; a role slug runs to four or more; a portal root is a
  // list, never a job; a job-id query param makes a detail link
  // even when the last path segment is the bare word 'job'.
  check(
    'gate: 3-word category slug is not a detail',
    isJobDetailUrl('https://www.ttecjobs.com/en/technology-and-digital') === false &&
      isJobDetailUrl('https://jobs.workingsolutions.com/') === false &&
      isJobDetailUrl('https://ats.rippling.com/liveops/jobs') === false,
    null,
  );
  check(
    'gate: 4-word role slug is a detail, query id overrides a bare segment',
    isJobDetailUrl('https://example.com/open-roles/senior-product-designer-remote') === true &&
      isJobDetailUrl('https://jobs.concentrix.com/job/?id=R1779018') === true,
    null,
  );
  check(
    'gate: junk title alone kills a real-looking URL, and vice versa',
    isJunkTitle('Customer service jobs') === true &&
      isJunkTitle('Customer Support Specialist') === false &&
      isRealPosting('Customer service jobs', 'https://rawco.example/jobs/frontend-developer') === false &&
      isRealPosting('Frontend Developer', 'https://www.ttecjobs.com/en/customer-service') === false,
    null,
  );
  // List and pagination URLs are not details: a search page whose
  // last segment starts with search/results/find, and any URL
  // carrying a pagination marker (&p=2 / ?page=2). The marker is a
  // segment START — '/about-careers/' is a marketing page, not a
  // job, while '/careers/jamaica/' stays a detail via its 'careers'
  // segment (TalentBrew's "Next" pager link used to parse as a
  // 9th posting titled "Next", 2026-11-12 local round).
  check(
    'gate: list/pagination URLs are not details',
    isJobDetailUrl('https://www.ttecjobs.com/en/search-jobs') === false &&
      isJobDetailUrl('https://www.ttecjobs.com/search-jobs&p=2') === false &&
      isJobDetailUrl('https://www.ttecjobs.com/jobs&p=2') === false &&
      isJobDetailUrl('https://www.ttecjobs.com/en/search-jobs?page=2') === false &&
      isJobDetailUrl('https://example.com/about-careers/') === false &&
      isJobDetailUrl('https://example.com/careers/jamaica/') === true,
    null,
  );
  check(
    'gate: navigation labels are junk titles',
    isJunkTitle('Next') === true &&
      isJunkTitle('Previous') === true &&
      isJunkTitle('Load more') === true &&
      isJunkTitle('Back End Developer') === false,
    null,
  );
  // End to end: a TTEC-like homepage full of junk links parses to
  // ZERO postings — including the footer link whose chunk happened
  // to contain the word Remote.
  const junkHtml = `<html><body>
<nav>
<div class="job-listing"><a href="/en/customer-service">Customer service jobs</a></div>
<div class="job-listing"><a href="/en/sales">Sales jobs</a></div>
<div class="job-listing"><a href="/en/work-from-home">Work from home jobs</a></div>
<div class="job-listing"><a href="/en/corporate">Corporate jobs</a></div>
<div class="job-listing"><a href="/en/technology">Technology jobs</a></div>
<div class="job-listing"><a href="/en/licensed-insurance">Licensed insurance agents careers</a></div>
<div class="job-listing"><a href="/en/veterans">Jobs for veterans &amp; military spouses</a></div>
<div class="job-listing"><a href="/en/interns">Jobs for interns &amp; recent grads</a></div>
<div class="job-listing"><a href="https://www.ttec.com/why-ttec">Join Our Talent Community</a></div>
<div class="job-listing"><p>Remote</p><a href="/en/privacy">OUR EMPLOYEES SAY IT BEST</a></div>
<div class="job-listing"><a href="/en/who-we-are">Driven by values. United by culture.</a></div>
<div class="job-listing"><a href="https://jobs.foundever.com/">Jobs near you</a></div>
</nav>
</body></html>`;
  check(
    'gate: junk-only homepage parses to zero postings',
    jobsMod.parseCareersPage(junkHtml, 'https://www.ttecjobs.com').length === 0,
    jobsMod.parseCareersPage(junkHtml, 'https://www.ttecjobs.com'),
  );
  // The same page with one real role mixed in yields exactly that role.
  const mixedHtml = junkHtml.replace(
    '</nav>',
    '<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div></nav>',
  );
  const mixedOut = jobsMod.parseCareersPage(mixedHtml, 'https://www.ttecjobs.com');
  check(
    'gate: real role survives on a junk-heavy page, junk stays dropped',
    mixedOut.length === 1 && mixedOut[0]?.title === 'Customer Support Specialist',
    mixedOut,
  );
  // Content scoring: a job-search input on the page is the strongest
  // portal signal; a bare shell scores nothing.
  check(
    'gate: portal content score reads search input + widget + list markers',
    jobsMod.portalContentScore('<html><body><input name="keyword" placeholder="Search jobs"></body></html>') === 5 &&
      jobsMod.portalContentScore('<html><body><div class="job-card"></div></body></html>') === 3 &&
      jobsMod.portalContentScore('<html><body><div id="root"></div></body></html>') === 0,
    null,
  );
  check(
    'gate: company-host bonus fires on the company ATS subdomain only',
    jobsMod.companyHostBonus('https://modsquad.wd5.myworkdayjobs.com/en-US/ModSquad', 'ModSquad') === 3 &&
      jobsMod.companyHostBonus('https://www.ttecjobs.com/', 'TTEC') === 3 &&
      jobsMod.companyHostBonus('https://ats.rippling.com/liveops/jobs', 'Liveops') === 0,
    null,
  );
}

async function testJunkWalkAndRender() {
  // The walk must NOT return on junk: a junk-only homepage stays
  // eligible for the render, the render target is the page with the
  // portal (its search input + company host), and the leads it
  // produces are stamped searched. A fetch-failed careers URL is
  // still a render candidate.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText = 'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const junkHtml = `<html><body>
<div class="job-listing"><a href="/en/customer-service">Customer service jobs</a></div>
<div class="job-listing"><a href="/en/sales">Sales jobs</a></div>
<div class="job-listing"><a href="/en/privacy">OUR EMPLOYEES SAY IT BEST</a><p>Remote</p></div>
<input name="keyword" placeholder="Search jobs">
</body></html>`;
  const renderedHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://tele.example')) {
      if (u === 'https://tele.example/careers') throw new Error('fetch failed');
      return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
    }
    // The homepage is the portal (junk links + a search box); the
    // /careers and /jobs guesses are bare shells.
    if (u === 'https://www.ttecjobs.com') return { ok: true, text: async () => junkHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const renderedUrls = [];
  const stubRender = async (url) => {
    renderedUrls.push(url);
    return { html: renderedHtml, searchOutcome: 'searched', searchMs: 250, renderedUrl: url };
  };
  // TTEC-like: junk homepage with a search box renders the homepage
  // (not a /careers guess) and finds the real role through it.
  const ttec = await jobsMod.searchCompanyJobs(
    { name: 'TTEC', website: 'https://www.ttecjobs.com', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubRender },
  );
  check(
    'junk-walk: junk-only homepage does not early-return; render finds the real role',
    ttec.renderUsed === true &&
      ttec.searchOutcome === 'searched' &&
      ttec.leads.length === 1 &&
      ttec.leads[0]?.title === 'Customer Support Specialist' &&
      ttec.postingsSeen === 1,
    ttec,
  );
  check(
    'junk-walk: render target is the portal homepage (search box + company host), not a guess',
    renderedUrls.length === 1 && renderedUrls[0] === 'https://www.ttecjobs.com',
    renderedUrls,
  );
  check(
    'junk-walk: rendered lead is stamped searched',
    ttec.leads[0]?.searched === true,
    ttec.leads[0],
  );
  // Fetch-failed careers URL still renders.
  renderedUrls.length = 0;
  const tele = await jobsMod.searchCompanyJobs(
    { name: 'Tele Co', website: 'https://tele.example', careersUrl: 'https://tele.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubRender },
  );
  check(
    'junk-walk: fetch-failed careers URL still becomes the render target',
    renderedUrls.length === 1 && renderedUrls[0] === 'https://tele.example/careers' && tele.renderUsed === true,
    { renderedUrls, renderUsed: tele.renderUsed },
  );
  // Stats telemetry: the chunk run proves the search fired.
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'TTEC', website: 'https://www.ttecjobs.com', domain: 'ttecjobs.com', nameKey: 'ttec', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  const out = await jobsMod.runFindJobs(
    { companiesCol },
    { resumeText, cursor: 0, limit: 15 },
    { renderPage: stubRender },
  );
  check(
    'junk-walk: stats count the search (searched + render attempts + ms)',
    out.stats.searchSearched === 1 &&
      out.stats.renderAttempts === 1 &&
      out.stats.rendered === 1 &&
      out.stats.searchMs === 250 &&
      out.stats.searchNoForm === 0,
    out.stats,
  );
  check(
    'junk-walk: chunk lead carries the searched flag',
    out.leads.length === 1 && out.leads[0]?.searched === true,
    out.leads,
  );
}

async function testTalentBrewAndRenderError() {
  // TalentBrew (TTEC): class-less <a data-job-id> cards wrapping an h2
  // title + .job-location span. Strategies A–C all miss them; Strategy D
  // matches on the data-job-id marker and reads the span location.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const tbHtml = `<html><body><ul>
  <li><a href="/en/job/las-vegas/customer-service-representative/44028/103182764528" data-job-id="103182764528">
    <div class="sr-job-list-wrap"><h2 class="job-title-logo-spacing">Customer Service Representative</h2>
    <span class="job-location logo-spacing">Las Vegas, Nevada</span></div></a></li>
  <li><a href="/en/job/athens/dutch-customer-service-in-support-of-booking-com/44028/103179030912" data-job-id="103179030912">
    <div class="sr-job-list-wrap"><h2 class="job-title-logo-spacing">Dutch - Customer Service in support of Booking.com</h2>
    <span class="job-location logo-spacing">Athens, Greece</span></div></a></li>
  <li><a href="/en/job/las-vegas/join-our-team/44028/103182764529" data-job-id="103182764529">
    <div class="sr-job-list-wrap"><h2 class="job-title-logo-spacing">Join our team</h2>
    <span class="job-location logo-spacing">Las Vegas, Nevada</span></div></a></li>
  <li><a href="/en/job/athens/french-customer-service/44028/103179030913" data-job-id="103179030913">
    <div class="sr-job-list-wrap"><h2 class="job-title-logo-spacing">Fran&#xE7;ais/Anglais - Conseiller / Conseill&#xE8;re voyages pour Booking.com</h2>
    <span class="job-location logo-spacing">Athens, Greece</span></div></a></li>
</ul></body></html>`;
  const tb = jobsMod.parseCareersPage(tbHtml, 'https://www.ttecjobs.com/en/search-jobs');
  check('talentbrew: 3 real cards parsed (junk title dropped)', tb.length === 3, tb);
  check('talentbrew: US card fields resolved', tb[0]?.title === 'Customer Service Representative' && tb[0]?.location === 'Las Vegas, Nevada' && tb[0]?.url === 'https://www.ttecjobs.com/en/job/las-vegas/customer-service-representative/44028/103182764528', tb[0]);
  check('talentbrew: non-US card keeps its location', tb[1]?.location === 'Athens, Greece', tb[1]);
  check('talentbrew: numeric entities decode in the title (Français)', tb[2]?.title === 'Français/Anglais - Conseiller / Conseillère voyages pour Booking.com' && tb[2]?.location === 'Athens, Greece', tb[2]);
  // Careers-like URLs: a jobs./careers. subdomain homepage counts (it
  // IS the portal), a plain homepage does not.
  check(
    'careers-like: jobs/careers subdomain homepage counts, plain homepage does not',
    jobsMod.isCareersLikeUrl('https://jobs.teleperformance.com', '') === true &&
      jobsMod.isCareersLikeUrl('https://jobs.teleperformance.com/', '') === true &&
      jobsMod.isCareersLikeUrl('https://careers.example.com', '') === true &&
      jobsMod.isCareersLikeUrl('https://www.teleperformance.com', '') === false &&
      jobsMod.isCareersLikeUrl('https://tele.example/careers', '') === true &&
      jobsMod.isCareersLikeUrl('https://tele.example/careers', 'https://tele.example/careers') === true,
    null,
  );
  // Render failure surfaces instead of vanishing: a stub renderer that
  // dies returns its error on the result; a null renderer leaves it null.
  const resumeText = 'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const dead = await jobsMod.searchCompanyJobs(
    { name: 'Dead Co', website: 'https://dead.example', careersUrl: 'https://dead.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: async () => ({ html: '', searchOutcome: null, searchMs: 0, renderedUrl: '', renderError: 'render-failed' }) },
  );
  check(
    'render-error: failed render reports attempted + error, zero postings',
    dead.renderAttempted === true && dead.renderError === 'render-failed' && dead.postingsSeen === 0 && dead.leads.length === 0,
    dead,
  );
  const nullRender = await jobsMod.searchCompanyJobs(
    { name: 'Dead Co', website: 'https://dead.example', careersUrl: 'https://dead.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: async () => null },
  );
  check(
    'render-error: null render leaves error null',
    nullRender.renderAttempted === true && nullRender.renderError === null,
    nullRender,
  );
}

async function testRound4() {
  // Batch 4 (2026-11-12 canary): Strategy E (Rippling UUID anchors),
  // the teaser fallback (a single posting on a non-list page), and
  // the glued-title guard in titleOk.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  // Strategy E: Rippling rows are bare anchors to /jobs/<uuid> with
  // the title in a plain <div> — no heading, no job-ish class, no
  // data-job-id. Strategy A would read the whole row as one glued
  // title ("Agent Success Remote (United States) View job"); the
  // titleOk CTA guard rejects it, so only Strategy E's clean title
  // lands.
  const ripplingHtml = `<html><body><div class="job-list">
<a href="/liveops/jobs/3e94f2e4-5247-4bdd-bfe0-ccb439465de0"><div>Agent Success</div><div>Remote (United States)</div><span>View job</span></a>
<a href="/liveops/jobs/a716704b-695c-41ea-8725-8378644e807b"><div>Agent Experience Specialist</div><div>Remote (United States)</div><span>View job</span></a>
<a href="/liveops/jobs/9234e10b-8292-46b8-b8fc-919e71f5f295"><div>Agent Support Specialist</div><div>Remote (United States)</div><span>View job</span></a>
</div></body></html>`;
  const rip = jobsMod.parseCareersPage(ripplingHtml, 'https://ats.rippling.com/liveops/jobs');
  check('strategy-e: 3 Rippling rows parsed', rip.length === 3, rip);
  check(
    'strategy-e: titles are clean (no glued location / View job)',
    rip[0]?.title === 'Agent Success' &&
      rip[1]?.title === 'Agent Experience Specialist' &&
      rip[2]?.title === 'Agent Support Specialist',
    rip.map((p) => p.title),
  );
  check(
    'strategy-e: locations read Remote, URLs are the UUID detail links',
    rip[0]?.location === 'Remote' &&
      rip[0]?.url === 'https://ats.rippling.com/liveops/jobs/3e94f2e4-5247-4bdd-bfe0-ccb439465de0',
    rip[0],
  );
  // A UUID anchor with no title-like segment yields nothing.
  const noTitleHtml = `<html><body><a href="/liveops/jobs/3e94f2e4-5247-4bdd-bfe0-ccb439465de0"><div>Remote (United States)</div><span>View job</span></a></body></html>`;
  check(
    'strategy-e: a location-only row yields no posting',
    jobsMod.parseCareersPage(noTitleHtml, 'https://ats.rippling.com/liveops/jobs').length === 0,
    null,
  );
  // Teaser fallback: a homepage with ONE posting and a /careers page
  // with three — the walk must return the /careers list, not the
  // homepage teaser.
  const teaserHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  const listHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
<div class="job-listing"><h3>Call Center Agent</h3><p>Location: Remote</p><a href="/jobs/call-center-agent">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://teaser.example/careers') return { ok: true, text: async () => listHtml };
    if (u === 'https://teaser.example') return { ok: true, text: async () => teaserHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const listed = await jobsMod.searchCompanyJobs(
    { name: 'Teaser Co', website: 'https://teaser.example', careersUrl: '', isUSCompany: true },
    resumeText,
    {},
  );
  check(
    'teaser: a 1-posting homepage does not stop the walk; the /careers list wins',
    listed.postingsSeen === 3 && listed.sourcePage === 'https://teaser.example/careers' && listed.leads.length >= 2,
    { postingsSeen: listed.postingsSeen, sourcePage: listed.sourcePage, leads: listed.leads },
  );
  // Teaser-only company: the one featured role still comes back as
  // the fallback when nothing better exists.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://teaser.example') return { ok: true, text: async () => teaserHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const only = await jobsMod.searchCompanyJobs(
    { name: 'Teaser Co', website: 'https://teaser.example', careersUrl: '', isUSCompany: true },
    resumeText,
    {},
  );
  check(
    'teaser: a lone featured role returns as the fallback, not zero',
    only.postingsSeen === 1 && only.sourcePage === 'https://teaser.example' && only.leads.length === 1,
    { postingsSeen: only.postingsSeen, sourcePage: only.sourcePage, leads: only.leads },
  );
  // isListLikeUrl: the user-given link and list paths count; a bare
  // homepage does not.
  check(
    'teaser: list-like URL detection',
    jobsMod.isListLikeUrl('https://tele.example/careers', '') === true &&
      jobsMod.isListLikeUrl('https://jobs.tele.example/job-search/', '') === true &&
      jobsMod.isListLikeUrl('https://jobs.tele.example/', '') === false &&
      jobsMod.isListLikeUrl('https://tele.example/', 'https://tele.example/') === true &&
      jobsMod.isListLikeUrl('https://tele.example/about', '') === false,
    null,
  );
}

async function testRound5() {
  // Batch 5 (2026-11-12 canary vs 7d80afa): 'support' is a role word
  // (ModSquad's real CS roles died on the gate), a single posting is
  // always a teaser even on a list-like path (Teleperformance), and
  // cookie-accept telemetry rides the render attempts (Foundever/Sitel).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- Gate: 'support' is the role -------------------------------
  // ModSquad's live 12: 'Customer Service Phone Support',
  // 'Customer Service Support' and 'Remote Technical Customer
  // Support' are real remote CS roles the gate rejected as
  // no-match, because 'support' was not a role word.
  const modsquad = jobsMod.screenPostings(
    'ModSquad',
    [
      { title: 'Remote Technical Customer Support - QA and Game Dev', location: 'Remote', url: 'https://example.com/jobs/1', description: '', postedDate: '' },
      { title: 'Customer Service Phone Support', location: 'Remote', url: 'https://example.com/jobs/2', description: '', postedDate: '' },
      { title: 'Customer Service Support', location: 'Remote', url: 'https://example.com/jobs/3', description: '', postedDate: '' },
      { title: 'Gaming Support - T2 Ticket CS (Korean Language)', location: 'Remote', url: 'https://example.com/jobs/4', description: '', postedDate: '' },
      { title: 'Remote Gaming Moderation Specialist', location: 'Remote', url: 'https://example.com/jobs/5', description: '', postedDate: '' },
      { title: 'Field Service Technician', location: 'Remote', url: 'https://example.com/jobs/6', description: '', postedDate: '' },
      { title: 'Sales Support', location: 'Remote', url: 'https://example.com/jobs/7', description: '', postedDate: '' },
    ],
    resumeText,
    true,
  );
  const byTitle = (t) => modsquad.leads.find((l) => l.title === t);
  check(
    'gate-support: ModSquad CS titles pass the gate as leads',
    byTitle('Remote Technical Customer Support - QA and Game Dev')?.matchScore >= 60 &&
      byTitle('Customer Service Phone Support')?.matchScore >= 60 &&
      byTitle('Customer Service Support')?.matchScore >= 60,
    modsquad.leads.map((l) => [l.title, l.matchScore]),
  );
  check(
    'gate-support: moderation + field-service titles still die on the gate',
    !byTitle('Remote Gaming Moderation Specialist') && !byTitle('Field Service Technician'),
    modsquad.rejected.map((r) => r.title),
  );
  check(
    'gate-support: a bare Sales Support passes the gate but stays a near-miss (<60)',
    byTitle('Sales Support')?.matchScore < 60,
    byTitle('Sales Support')?.matchScore,
  );

  // --- Teaser: a single posting on a LIST-LIKE path is still a
  // teaser (Teleperformance's /en-us/careers/job-opportunities/
  // carries one featured role while the portal holds hundreds, and
  // the segment test called it a list).
  const teaserHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  const listHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
<div class="job-listing"><h3>Call Center Agent</h3><p>Location: Remote</p><a href="/jobs/call-center-agent">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://jobs.tele.example' || u === 'https://jobs.tele.example/careers' || u === 'https://jobs.tele.example/jobs') {
      throw new Error('RST');
    }
    if (u === 'https://tele.example') {
      return { ok: true, text: async () => `<html><body><a href="/en-us/careers/job-opportunities/">See all jobs</a></body></html>` };
    }
    if (u === 'https://tele.example/en-us/careers/job-opportunities/') return { ok: true, text: async () => teaserHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const renderedCalls = [];
  const stubList = async (url) => {
    renderedCalls.push(url);
    return { html: listHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false };
  };
  const tele = await jobsMod.searchCompanyJobs(
    { name: 'Teleperformance', website: 'https://jobs.tele.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubList },
  );
  check(
    'teaser-listlike: a 1-posting list-like page does not stop the walk; the jobs-portal render wins',
    renderedCalls.length >= 1 &&
      renderedCalls[0] === 'https://jobs.tele.example' &&
      tele.postingsSeen === 3 &&
      tele.leads.length >= 2 &&
      tele.renderUsed === true,
    { renderedCalls, postingsSeen: tele.postingsSeen, leads: tele.leads.length },
  );
  check(
    'cookie-telemetry: accept clicks + banner flag ride the attempt record',
    tele.renderAttempts.length >= 1 &&
      tele.renderAttempts[0]?.cookieClicks === 0 &&
      tele.renderAttempts[0]?.bannerPresent === false,
    tele.renderAttempts,
  );
  // Same company, no render: the single featured role still returns
  // as the fallback, not zero.
  const teleNoRender = await jobsMod.searchCompanyJobs(
    { name: 'Teleperformance', website: 'https://jobs.tele.example', careersUrl: '', isUSCompany: true },
    resumeText,
    {},
  );
  check(
    'teaser-listlike: with no render the single featured role still returns as the fallback',
    teleNoRender.postingsSeen === 1 &&
      teleNoRender.sourcePage === 'https://tele.example/en-us/careers/job-opportunities/' &&
      teleNoRender.leads.length === 1,
    { postingsSeen: teleNoRender.postingsSeen, sourcePage: teleNoRender.sourcePage, leads: teleNoRender.leads },
  );
  // A render stub that omits the cookie fields defaults to 0 clicks,
  // no banner.
  const stubNoCookie = async (url) => ({ html: listHtml, searchOutcome: 'has-listings', searchMs: 1, renderedUrl: url });
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body><div id="root"></div></body></html>' });
  const noCookie = await jobsMod.searchCompanyJobs(
    { name: 'Cookie Co', website: 'https://cookie.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubNoCookie },
  );
  check(
    'cookie-telemetry: a render without cookie fields defaults to 0 clicks, no banner',
    noCookie.renderAttempts.length === 1 &&
      noCookie.renderAttempts[0]?.cookieClicks === 0 &&
      noCookie.renderAttempts[0]?.bannerPresent === false,
    noCookie.renderAttempts,
  );
}

async function testRound6() {
  // Batch 6 (2026-11-12 canary vs 3aaab611): a page whose postings
  // all die as no-match is not the list — in the WALK or in the
  // RENDER (Teleperformance's values page parsed two junk
  // "postings" and the walk returned it as "the list" while the real
  // portal was never rendered); a marketing sentence is junk; the
  // accept step reports the button labels it could see
  // (Foundever/Sitel).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- isJunkTitle: a sentence is junk ---------------------------
  // Teleperformance's values page parsed as a posting titled 'We
  // believe that all employees need to be treated with respect,
  // dignity, and acceptance.' — a 15-word sentence ending in a
  // period. The word count guards abbreviations: 'Customer Service
  // Rep.' is three words and a real title.
  check(
    'gate-sentence: a marketing sentence ending in a period is junk',
    jobsMod.isJunkTitle('We believe that all employees need to be treated with respect, dignity, and acceptance.') === true &&
      jobsMod.isJunkTitle('Driven by values. United by culture.') === true,
    null,
  );
  check(
    'gate-sentence: a short title ending in an abbreviation period is still real',
    jobsMod.isJunkTitle('Customer Service Rep.') === false &&
      jobsMod.isJunkTitle('Customer Support Specialist') === false,
    null,
  );

  // --- Walk + render: an all-no-match page does not stop the walk
  // and does not stop the render ----------------------------------
  // Teleperformance's live sequence, replayed: the opportunities
  // page carries one teaser, the values page parses two junk
  // "postings" ('Jamaica', 'Our Culture'). The values page would
  // score 10 as a render target (job-list markers + two detail
  // links) and outrank the jobs homepage (9) — but the round-7
  // walked-with-postings penalty (-10) drops it to 3, so the render
  // goes to the portal first and the list wins at once. (The
  // render-loop continue past a junk page is covered by the round-7
  // loop test below, where the junk page was walked with ZERO
  // postings and so carries no penalty.)
  const teleTeaserHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  const teleValuesHtml = `<html><body>
<div class="job-listing"><a href="/en-us/careers/jamaica/">Jamaica</a></div>
<div class="job-listing"><a href="/en-us/careers/our-culture/">Our Culture</a></div>
</body></html>`;
  const teleListHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
<div class="job-listing"><h3>Call Center Agent</h3><p>Location: Remote</p><a href="/jobs/call-center-agent">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://jobs.tele.example' || u === 'https://jobs.tele.example/careers' || u === 'https://jobs.tele.example/jobs') {
      throw new Error('RST');
    }
    if (u === 'https://tele.example') {
      return { ok: true, text: async () => `<html><body><a href="/en-us/careers/job-opportunities/">See all jobs</a><a href="/en-us/careers/our-values-and-philosophy/">Our values</a></body></html>` };
    }
    if (u === 'https://tele.example/en-us/careers/job-opportunities/') return { ok: true, text: async () => teleTeaserHtml };
    if (u === 'https://tele.example/en-us/careers/our-values-and-philosophy/') return { ok: true, text: async () => teleValuesHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const renderedCalls = [];
  const stubPortalList = async (url) => {
    renderedCalls.push(url);
    if (url.includes('our-values')) {
      return { html: teleValuesHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: ['BUTTON:Accept All Cookies', 'A:Privacy Policy'] };
    }
    return { html: teleListHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 1, bannerPresent: true, bannerButtons: ['BUTTON:Accept All Cookies'] };
  };
  const tele = await jobsMod.searchCompanyJobs(
    { name: 'Teleperformance', website: 'https://jobs.tele.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubPortalList },
  );
  check(
    'all-nomatch: the junk values page does not stop the walk or the render; the portal wins',
    renderedCalls.length === 1 &&
      renderedCalls[0] === 'https://jobs.tele.example' &&
      tele.postingsSeen === 3 &&
      tele.leads.length >= 2 &&
      tele.renderUsed === true &&
      tele.sourcePage === 'https://jobs.tele.example',
    { renderedCalls, postingsSeen: tele.postingsSeen, leads: tele.leads.length, sourcePage: tele.sourcePage },
  );
  check(
    'banner-buttons: the accept-step labels ride the attempt record',
    tele.renderAttempts.length === 1 &&
      (tele.renderAttempts[0]?.bannerButtons ?? []).includes('BUTTON:Accept All Cookies') &&
      tele.renderAttempts[0]?.cookieClicks === 1 &&
      tele.renderAttempts[0]?.bannerPresent === true,
    tele.renderAttempts,
  );
  // Same company, the render finds nothing at all: the remembered
  // walk teaser (a real lead) still returns — it beats the
  // rendered page's junk.
  const stubDead = async (url) => {
    renderedCalls.push(url);
    return { html: '', searchOutcome: 'no-form', searchMs: 100, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: [] };
  };
  renderedCalls.length = 0;
  const teleDead = await jobsMod.searchCompanyJobs(
    { name: 'Teleperformance', website: 'https://jobs.tele.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubDead },
  );
  check(
    'all-nomatch: with a dead render the walk teaser still returns as the fallback',
    teleDead.postingsSeen === 1 &&
      teleDead.sourcePage === 'https://tele.example/en-us/careers/job-opportunities/' &&
      teleDead.leads.length === 1,
    { postingsSeen: teleDead.postingsSeen, sourcePage: teleDead.sourcePage, leads: teleDead.leads.length },
  );

  // --- Walk: a list rejected only on location still returns early
  // (TTEC's Athens roles) — it IS the list, just the wrong place.
  const athensHtml = `<html><body>
<div class="job-listing"><h3>Customer Service Representative</h3><p>Location: Athens, Greece</p><a href="/jobs/customer-service-representative">Apply</a></div>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Athens, Greece</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => athensHtml });
  const athens = await jobsMod.searchCompanyJobs(
    { name: 'Athens Co', website: 'https://athens.example', careersUrl: '', isUSCompany: true },
    resumeText,
    {},
  );
  check(
    'all-nomatch: a list rejected only on location still returns early, unrendered',
    athens.renderAttempted === false &&
      athens.postingsSeen === 2 &&
      athens.sourcePage === 'https://athens.example' &&
      athens.leads.length === 0,
    { renderAttempted: athens.renderAttempted, postingsSeen: athens.postingsSeen, sourcePage: athens.sourcePage },
  );

  // --- Render fallback: no walk postings, every render target
  // all-no-match — the rendered postings still come back, so
  // postingsSeen is not lost (NexRep's 4 correct rejections).
  const noMatchHtml = `<html><body>
<div class="job-listing"><h3>Quality Specialist</h3><p>Location: Remote</p><a href="/jobs/quality-specialist">Apply</a></div>
<div class="job-listing"><h3>Field Service Technician</h3><p>Location: Remote</p><a href="/jobs/field-service-technician">Apply</a></div>
<div class="job-listing"><h3>Sales Manager</h3><p>Location: Remote</p><a href="/jobs/sales-manager">Apply</a></div>
<div class="job-listing"><h3>Accounting Analyst</h3><p>Location: Remote</p><a href="/jobs/accounting-analyst">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const stubNoMatch = async (url) => ({
    html: noMatchHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: [],
  });
  const nex = await jobsMod.searchCompanyJobs(
    { name: 'Nex Co', website: 'https://nex.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubNoMatch },
  );
  // (Round 18: the loop now stops after ONE has-listings render
  // whose postings all reject — the fallback is the first render's
  // postings, and the second render is saved. The check's intent —
  // the all-rejected render's postings still come back — is
  // unchanged; only the renders spent changed, 2 -> 1.)
  check(
    'all-nomatch: an all-rejected render still returns its postings as the fallback',
    nex.postingsSeen === 4 && nex.leads.length === 0 && nex.renderAttempts.length === 1,
    { postingsSeen: nex.postingsSeen, leads: nex.leads.length, attempts: nex.renderAttempts.length },
  );
}

async function testRound7() {
  // Batch 7 (2026-11-12 round-6 canary vs 308821c4): the render
  // burned both attempts on marketing pages (Teleperformance's
  // opportunities/values pages score 15 and outrank the
  // fetch-failed jobs homepage at 9); Kelly's 'Help & Support'
  // nav item linked to /career-advice parsed as a posting and
  // scored 60 — a false-positive lead.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- isJobDetailUrl: a category slug is not a detail -----------
  // The last segment starts with a job-marker word and the rest is
  // a topic, not a role. 'career-details' survives (a later token
  // is a detail word); 'career-advice' does not.
  check(
    'gate-category: category slugs are not job-detail URLs',
    jobsMod.isJobDetailUrl('https://www.kellyservices.us/career-advice') === false &&
      jobsMod.isJobDetailUrl('https://tele.example/en-us/careers/job-opportunities/') === false &&
      jobsMod.isJobDetailUrl('https://example.com/careers/job-search') === false &&
      jobsMod.isJobDetailUrl('https://example.com/jobs/job-coach') === false,
    null,
  );
  check(
    'gate-category: real detail URLs still survive',
    jobsMod.isJobDetailUrl('https://houserx.example/career-details') === true &&
      jobsMod.isJobDetailUrl('https://example.com/jobs/customer-support-specialist') === true &&
      jobsMod.isJobDetailUrl('https://tele.example/en-us/careers/jamaica/') === true &&
      jobsMod.isJobDetailUrl('https://example.com/open-roles/senior-product-designer-remote') === true,
    null,
  );
  // End to end: Kelly's /careers page with the 'Help & Support'
  // nav item parses WITHOUT it — the false-positive lead is gone.
  const kellyHtml = `<html><body>
<div class="job-listing"><a href="/career-advice">Help &amp; Support</a></div>
<div class="job-listing"><h3>Forklift-Standup</h3><p>Location: Remote</p><a href="/jobs/forklift-standup">Apply</a></div>
</body></html>`;
  const kellyParsed = jobsMod.parseCareersPage(kellyHtml, 'https://www.kellyservices.us');
  check(
    'gate-category: Help & Support nav item no longer parses as a posting',
    kellyParsed.length === 1 && kellyParsed[0]?.title === 'Forklift-Standup',
    kellyParsed,
  );
  // A card whose location lives in a <span class="location"> (or
  // .job-location) carries that location — Strategy A/C cards and
  // TalentBrew cards alike. The span used to be ignored, so an
  // on-site role read as blank-location and passed the remote-only
  // sweep as a review lead (Foundever's "Retention … Virginia, US",
  // 2026-11-12 local round).
  const spanLocHtml = `<html><body>
<div class="job-card"><h3>Retention Customer Service Associate</h3><span class="location">Virginia, US</span><a href="/jobs/retention-customer-service-associate">Apply</a></div>
<div class="job-card"><h3>Remote Customer Service Representative</h3><span class="job-location">Remote, Any Location, US</span><a href="/jobs/remote-customer-service-representative">Apply</a></div>
</body></html>`;
  const spanLocParsed = jobsMod.parseCareersPage(spanLocHtml, 'https://portal.example/careers');
  check(
    'gate-category: location spans are read into the posting',
    spanLocParsed.length === 2 &&
      spanLocParsed[0]?.location === 'Virginia, US' &&
      spanLocParsed[1]?.location === 'Remote, Any Location, US',
    spanLocParsed,
  );

  // --- Render-target ordering: a walked-with-postings page ranks
  // below an unread portal (Teleperformance) ----------------------
  // Replays the round-6 canary: the walk reads the opportunities
  // (teaser) and values (2 junk) pages, the jobs homepage fetch
  // fails. The marketing pages score 15 raw; the -10 penalty drops
  // them below the jobs homepage (9), so the render goes to the
  // portal first.
  const teleTeaserHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  const teleValuesHtml = `<html><body>
<div class="job-listing"><a href="/en-us/careers/jamaica/">Jamaica</a></div>
<div class="job-listing"><a href="/en-us/careers/our-culture/">Our Culture</a></div>
</body></html>`;
  const teleListHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
<div class="job-listing"><h3>Call Center Agent</h3><p>Location: Remote</p><a href="/jobs/call-center-agent">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://jobs.tele.example' || u === 'https://jobs.tele.example/careers' || u === 'https://jobs.tele.example/jobs') {
      throw new Error('RST');
    }
    if (u === 'https://tele.example') {
      return { ok: true, text: async () => `<html><body><a href="/en-us/careers/job-opportunities/">See all jobs</a><a href="/en-us/careers/our-values-and-philosophy/">Our values</a></body></html>` };
    }
    if (u === 'https://tele.example/en-us/careers/job-opportunities/') return { ok: true, text: async () => teleTeaserHtml };
    if (u === 'https://tele.example/en-us/careers/our-values-and-philosophy/') return { ok: true, text: async () => teleValuesHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const renderedCalls = [];
  const stubList = async (url) => {
    renderedCalls.push(url);
    return { html: teleListHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: [] };
  };
  const tele = await jobsMod.searchCompanyJobs(
    { name: 'Teleperformance', website: 'https://jobs.tele.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubList },
  );
  check(
    'target-order: the unread jobs homepage outranks the walked marketing pages',
    renderedCalls.length === 1 &&
      renderedCalls[0] === 'https://jobs.tele.example' &&
      tele.renderTargets[0]?.url === 'https://jobs.tele.example' &&
      tele.leads.length >= 2,
    { renderedCalls, targets: tele.renderTargets, leads: tele.leads.length },
  );

  // --- Render-loop continue, unpenalized junk page --------------
  // A marketing page the walk read with ZERO postings carries no
  // penalty (its listings may be JS-only), so it can still outrank
  // the portal — and the round-6 loop rule must pass it by when
  // the render finds only junk there. The page's job-listing divs
  // link to vetoed category slugs, so the walk parses 0 postings
  // from it, but its search input + markers still score it 10,
  // above the fetch-failed jobs homepage (9).
  const loopMarketingHtml = `<html><body>
<input name="keyword" placeholder="Search jobs">
<div class="job-listing"><a href="/careers/job-opportunities/">See opportunities</a></div>
<div class="job-listing"><a href="/career-advice/">Career advice</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://jobs.loop.example' || u === 'https://jobs.loop.example/careers' || u === 'https://jobs.loop.example/jobs') {
      throw new Error('RST');
    }
    if (u === 'https://loop.example') {
      return { ok: true, text: async () => `<html><body><a href="/about-careers/">About careers</a></body></html>` };
    }
    if (u === 'https://loop.example/about-careers/') return { ok: true, text: async () => loopMarketingHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const loopCalls = [];
  const stubLoop = async (url) => {
    loopCalls.push(url);
    if (url.includes('about-careers')) {
      // The values page reports 'no-form', not 'has-listings': the
      // real detector requires a POSITIVE results-count line for
      // has-listings (hasVisibleListings = resultsText && jobLinks
      // >= 1), and a values page carries no count line — the live TP
      // values page reported 'no-form' (2026-11-12 canary). A stub
      // that returns 'has-listings' here would contradict the
      // detector; the check still pins the intent (a junk first
      // render does not stop the loop) on the realistic path.
      return { html: teleValuesHtml, searchOutcome: 'no-form', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: [] };
    }
    return { html: teleListHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url, cookieClicks: 0, bannerPresent: false, bannerButtons: [] };
  };
  const loop = await jobsMod.searchCompanyJobs(
    { name: 'Loop Co', website: 'https://jobs.loop.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubLoop },
  );
  check(
    'target-order: a junk first render does not stop the loop; the portal wins second',
    loopCalls.length === 2 &&
      loopCalls[0].includes('about-careers') &&
      loopCalls[1] === 'https://jobs.loop.example' &&
      loop.postingsSeen === 3 &&
      loop.leads.length >= 2,
    { loopCalls, postingsSeen: loop.postingsSeen, leads: loop.leads.length },
  );
}

async function testRound8() {
  // Batch 8 (2026-11-12 round-7 canary vs 3a7f91f2): Foundever's
  // render shows clicks 1 with the banner still up, and the
  // labels list alone cannot say WHAT was clicked; bannerPresent
  // is text-based, so residual copy reads as "banner up" after a
  // working click. Two new diagnostics ride the attempt record.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  const listHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const stubDiag = async (url) => ({
    html: listHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url,
    cookieClicks: 1, bannerPresent: true, bannerButtons: ['A:Manage your cookie preferences'],
    cookieClickedLabel: 'Accept All Cookies', bannerVisible: false,
  });
  const res = await jobsMod.searchCompanyJobs(
    { name: 'Diag Co', website: 'https://diag.example', careersUrl: 'https://diag.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubDiag },
  );
  check(
    'banner-diag: clicked label + visible flag ride the attempt record',
    res.renderAttempts.length >= 1 &&
      res.renderAttempts[0]?.cookieClickedLabel === 'Accept All Cookies' &&
      res.renderAttempts[0]?.bannerVisible === false &&
      res.renderAttempts[0]?.bannerPresent === true &&
      res.renderAttempts[0]?.cookieClicks === 1,
    res.renderAttempts,
  );
  // A render that never clicked reports null / false, not garbage.
  const stubNone = async (url) => ({
    html: listHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url,
    cookieClicks: 0, bannerPresent: false, bannerButtons: [],
  });
  const resNone = await jobsMod.searchCompanyJobs(
    { name: 'Diag Co', website: 'https://diag.example', careersUrl: 'https://diag.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubNone },
  );
  check(
    'banner-diag: no click reports null label and no visible banner',
    resNone.renderAttempts.length >= 1 &&
      resNone.renderAttempts[0]?.cookieClickedLabel === null &&
      resNone.renderAttempts[0]?.bannerVisible === false,
    resNone.renderAttempts,
  );
}

async function testRound9() {
  // Batch 9 (2026-11-12 round-8 canary vs c5012bf1): Foundever's
  // render shows clicks 1 with clickedLabel null (a later no-match
  // call overwrote the label — fixed: only a click updates it),
  // and Sitel's no-form cannot say whether the "Find a job in your
  // country" toggle fired. The toggle label rides the attempt
  // record; the dismissBanner reload is skipped when under 12s
  // remain, so the search keeps its 6s (Foundever skipped-time).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  // A toggle that fired but revealed no form: the label still rides
  // the attempt record.
  const stubToggle = async (url) => ({
    html: '', searchOutcome: 'no-form', searchMs: 900, renderedUrl: url,
    cookieClicks: 0, bannerPresent: true, bannerButtons: ['BUTTON:Find a job in your country'],
    cookieClickedLabel: null, bannerVisible: true, searchToggleClicked: 'Find a job in your country',
  });
  const res = await jobsMod.searchCompanyJobs(
    { name: 'Toggle Co', website: 'https://toggle.example', careersUrl: 'https://toggle.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubToggle },
  );
  check(
    'toggle-diag: the toggle click label rides the attempt record',
    res.renderAttempts.length >= 1 &&
      res.renderAttempts[0]?.searchToggleClicked === 'Find a job in your country' &&
      res.renderAttempts[0]?.bannerVisible === true,
    res.renderAttempts,
  );
  // A render with no toggle reports null.
  const stubNone = async (url) => ({
    html: '', searchOutcome: 'no-form', searchMs: 900, renderedUrl: url,
    cookieClicks: 0, bannerPresent: false, bannerButtons: [],
  });
  const resNone = await jobsMod.searchCompanyJobs(
    { name: 'Toggle Co', website: 'https://toggle.example', careersUrl: 'https://toggle.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubNone },
  );
  check(
    'toggle-diag: no toggle reports a null label',
    resNone.renderAttempts.length >= 1 && resNone.renderAttempts[0]?.searchToggleClicked === null,
    resNone.renderAttempts,
  );
}

async function testRound11() {
  // Batch 11 (2026-11-12 round-10 canary vs 0055509d): Sitel's
  // toggle fires on both attempts but the picker reveals one
  // unqualifying input — the search needs a country pick after
  // the toggle. The pick label rides the attempt record.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const stubPick = async (url) => ({
    html: '', searchOutcome: 'no-form', searchMs: 900, renderedUrl: url,
    cookieClicks: 0, bannerPresent: true, bannerButtons: ['BUTTON:Find a job in your country'],
    cookieClickedLabel: null, bannerVisible: true,
    searchToggleClicked: 'Find a job in your country', searchCountryClicked: 'United States',
  });
  const res = await jobsMod.searchCompanyJobs(
    { name: 'Pick Co', website: 'https://pick.example', careersUrl: 'https://pick.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubPick },
  );
  check(
    'country-diag: the country pick label rides the attempt record',
    res.renderAttempts.length >= 1 &&
      res.renderAttempts[0]?.searchCountryClicked === 'United States' &&
      res.renderAttempts[0]?.searchToggleClicked === 'Find a job in your country',
    res.renderAttempts,
  );
  const stubNone = async (url) => ({
    html: '', searchOutcome: 'no-form', searchMs: 900, renderedUrl: url,
    cookieClicks: 0, bannerPresent: false, bannerButtons: [],
  });
  const resNone = await jobsMod.searchCompanyJobs(
    { name: 'Pick Co', website: 'https://pick.example', careersUrl: 'https://pick.example/careers', isUSCompany: true },
    resumeText,
    { renderPage: stubNone },
  );
  check(
    'country-diag: no country pick reports a null label',
    resNone.renderAttempts.length >= 1 && resNone.renderAttempts[0]?.searchCountryClicked === null,
    resNone.renderAttempts,
  );
}

async function testMatchingFixes() {
  // The 0/3004 fix round: synonym groups replace the hard title gate,
  // location becomes three-way (ok / review / reject), and JSON-LD on
  // the same page joins the page's sources.
  const mod = freshRequire(`${OUT}/test-company.cjs`);
  const handler = mod.default;
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resume =
    'React TypeScript JavaScript frontend developer with Storybook and design systems experience';
  // Resume terms after plural stemming (all count 1, alphabetical):
  // design, developer, frontend, javascript, react, storybook, system,
  // typescript = 8 terms, so each matched term is worth 50/8 = 6.25.

  // Direct location verdicts.
  const lv = jobsMod.locationVerdict;
  check('location: Remote, US ok', lv('Remote, US', '').verdict === 'ok', lv('Remote, US', ''));
  check(
    'location: bare Remote is review, not ok',
    lv('Remote', '').verdict === 'review',
    lv('Remote', ''),
  );
  check(
    'location: bare Remote + body US evidence ok',
    lv('Remote', 'Candidates must be based in the United States').verdict === 'ok',
    lv('Remote', 'Candidates must be based in the United States'),
  );
  check(
    'location: empty + body remote/US ok',
    lv('', 'Remote role. Must be based in the United States.').verdict === 'ok',
    lv('', 'Remote role. Must be based in the United States.'),
  );
  check(
    'location: empty + no remote is review',
    lv('', 'Frontend Developer').verdict === 'review',
    lv('', 'Frontend Developer'),
  );
  check(
    'location: Indiana maps to in, not excluded india',
    lv('Remote, Indiana', '').verdict === 'reject' &&
      lv('Remote, Indiana', '').flag === 'state-restricted remote: in',
    lv('Remote, Indiana', ''),
  );
  check(
    'location: hybrid still rejects',
    lv('Hybrid, Austin TX', '').verdict === 'reject',
    lv('Hybrid, Austin TX', ''),
  );
  // Nov 10 CS sweep blind spot: Niche's 'Sr. Product Analyst (Brazil
  // & Argentina ONLY)', location 'Remote', passed as 'Remote (US
  // company)' for a U.S. company. An explicit non-US-only restriction
  // in the title/description must reject, even with a blank location
  // or a bare-'Remote' line and a U.S. company.
  check(
    'location: Brazil & Argentina ONLY in title rejects for US company',
    lv('Remote', 'Sr. Product Analyst (Brazil & Argentina ONLY)', true).verdict === 'reject',
    lv('Remote', 'Sr. Product Analyst (Brazil & Argentina ONLY)', true),
  );
  check(
    'location: Brazil-only hiring in description rejects, blank location',
    lv(
      '',
      'We are currently recruiting for this role in Argentina and Brazil only. We will not be considering US based candidates at this time.',
      true,
    ).verdict === 'reject',
    lv(
      '',
      'We are currently recruiting for this role in Argentina and Brazil only. We will not be considering US based candidates at this time.',
      true,
    ),
  );
  check(
    'location: blank location + US company still passes without a restriction',
    lv('', 'Customer Service Representative', true).verdict === 'ok',
    lv('', 'Customer Service Representative', true),
  );
  check(
    'location: Remote, US line still wins over a stray place name in the description',
    lv('Remote, US', 'Our team works with colleagues in Brazil.').verdict === 'ok',
    lv('Remote, US', 'Our team works with colleagues in Brazil.'),
  );

  // Helper: run test-company against one canned careers page.
  async function runPage(html) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u === 'https://fixco.example/careers') return { ok: true, text: async () => html };
      return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
    };
    const res = mkRes();
    await handler(
      mkReq(
        'POST',
        {
          company: { name: 'FixCo', website: '', careersUrl: 'https://fixco.example/careers' },
          resumeText: resume,
        },
        { 'x-sync-key': 'testkey' },
      ),
      res,
    );
    return res.body;
  }
  const listing = (title, locLine, href) =>
    `<div class="job-listing"><h3>${title}</h3>${locLine ? `<p>Location: ${locLine}</p>` : ''}<a href="${href}">Apply</a></div>`;
  const page = (body) => `<html><body>${body}</body></html>`;

  // The headline bug: 'Software Engineer' used to die on the title gate
  // (the resume never says 'software' or 'engineer'). Now it matches
  // through the engineer → developer alias.
  const se = await runPage(
    page(listing('Software Engineer (Frontend)', 'Remote, US', '/jobs/se-frontend')),
  );
  check(
    'software engineer (frontend) found at 63, not gated out',
    se.leads?.length === 1 && se.leads[0]?.matchScore === 63 && se.leads[0]?.needsReview === false,
    se.leads,
  );
  check(
    'software engineer strength shows the alias path',
    se.leads?.[0]?.strengths?.includes('Developer (via Engineer)') === true,
    se.leads?.[0]?.strengths,
  );

  // Dropped synonyms must not match.
  const client = await runPage(
    page(listing('Client Success Manager', 'Remote, US', '/jobs/client-success')),
  );
  check('client success manager excluded (client dropped)', client.leads?.length === 0, client.leads);
  const bizdev = await runPage(
    page(listing('Business Development Manager', 'Remote, US', '/jobs/bizdev')),
  );
  check(
    'business development manager excluded (development dropped)',
    bizdev.leads?.length === 0,
    bizdev.leads,
  );

  // Ambiguous-only matches never qualify a posting on their own.
  const webContent = await runPage(
    page(listing('Web Content Specialist', 'Remote, US', '/jobs/web-content')),
  );
  check(
    'web content specialist excluded (web-only match)',
    webContent.leads?.length === 0,
    webContent.leads,
  );
  const webEng = await runPage(page(listing('Web Engineer', 'Remote, US', '/jobs/web-eng')));
  check(
    'web engineer included (web + engineer)',
    webEng.leads?.length === 1 && webEng.leads[0]?.matchScore === 63,
    webEng.leads,
  );

  // Plurals stem: 'Frontend Developers' matches 'developer'.
  const plurals = await runPage(
    page(listing('Frontend Developers Wanted', 'Remote, US', '/jobs/frontend-devs')),
  );
  check(
    'plural title matches',
    plurals.leads?.length === 1 && plurals.leads[0]?.matchScore === 63,
    plurals.leads,
  );

  // Bare 'Remote' and empty location: review-only, never auto-add.
  const bare = await runPage(page(listing('Frontend Developer', 'Remote', '/jobs/frontend-dev')));
  check(
    'bare Remote lead is review-only',
    bare.leads?.length === 1 &&
      bare.leads[0]?.needsReview === true &&
      bare.leads[0]?.locationFlag === 'Remote (no country stated — verify)',
    bare.leads?.[0],
  );
  const noLoc = await runPage(
    page(
      `<div class="job-listing"><h3>Frontend Developer</h3><a href="/jobs/frontend-dev">Apply</a></div>`,
    ),
  );
  check(
    'empty location lead is review-only',
    noLoc.leads?.length === 1 &&
      noLoc.leads[0]?.needsReview === true &&
      noLoc.leads[0]?.locationFlag === 'no location listed — verify',
    noLoc.leads?.[0],
  );

  // Greenhouse embed: description-carried matches + body US evidence.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://boards-api.greenhouse.io/v1/boards/fixco/jobs?content=true') {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jobs: [
              {
                title: 'Software Engineer',
                location: { name: 'Remote, US' },
                absolute_url: 'https://fixco.example/careers?gh_jid=1',
                content: '<p>Build React interfaces with TypeScript.</p>',
                created_at: '2026-10-20T00:00:00Z',
              },
              {
                title: 'Security Analyst',
                location: { name: 'Remote, US' },
                absolute_url: 'https://fixco.example/careers?gh_jid=2',
                content: '<p>TS/SCI clearance required.</p>',
                created_at: '2026-10-20T00:00:00Z',
              },
              {
                title: 'Frontend Developer',
                location: { name: '' },
                absolute_url: 'https://fixco.example/careers?gh_jid=3',
                content:
                  '<p>Remote role. Candidates must be based in the United States. React TypeScript work.</p>',
                created_at: '2026-10-20T00:00:00Z',
              },
            ],
          }),
      };
    }
    if (u === 'https://fixco.example/careers') {
      return {
        ok: true,
        text: async () =>
          '<html><body><script src="https://boards.greenhouse.io/embed/job_board/js?for=fixco"></script></body></html>',
      };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const ghRes = mkRes();
  await handler(
    mkReq(
      'POST',
      {
        company: { name: 'FixCo', website: '', careersUrl: 'https://fixco.example/careers' },
        resumeText: resume,
      },
      { 'x-sync-key': 'testkey' },
    ),
    ghRes,
  );
  const gh = ghRes.body;
  check(
    'greenhouse: software engineer found at 69 via description',
    gh.leads?.some((l) => l.title === 'Software Engineer' && l.matchScore === 69) === true,
    gh.leads,
  );
  check(
    'greenhouse: TS/SCI-only posting excluded (ts ambiguous)',
    gh.leads?.some((l) => l.title === 'Security Analyst') === false,
    gh.leads,
  );
  const emptyLocLead = gh.leads?.find((l) => l.title === 'Frontend Developer');
  check(
    'greenhouse: empty location + body US evidence is ok, not review',
    emptyLocLead?.needsReview === false &&
      emptyLocLead?.locationFlag === 'Remote (US, confirmed in posting)' &&
      emptyLocLead?.matchScore === 75,
    emptyLocLead,
  );
  check(
    'greenhouse: lead sourceType recorded',
    gh.leads?.every((l) => l.sourceType === 'greenhouse') === true,
    gh.leads,
  );

  // JSON-LD: direct parser + end-to-end through the page union.
  const ldHtml = `<html><body>
<div class="job-listing"><h3>Loan Analyst</h3><p>Location: Remote, US</p><a href="/jobs/loan-analyst">Apply</a></div>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
{"@type":"JobPosting","title":"Frontend Developer","url":"https://fixco.example/jobs/frontend-developer","description":"React work.","datePosted":"2026-10-20","jobLocationType":"TELECOMMUTE","applicantLocationRequirements":{"@type":"Country","name":"United States"}},
{"@type":"JobPosting","title":"Backend Engineer","url":"https://boards.greenhouse.io/fixco/jobs/9","description":"Node work."},
{"@type":"JobPosting","title":"Stale Role","url":"https://fixco.example/jobs/stale","description":"Old.","validThrough":"2020-01-01"},
{"@type":"JobPosting","title":"Data Analyst","url":"https://fixco.example/jobs/data-analyst","description":"SQL work.","datePosted":"2026-10-21","jobLocation":{"@type":"Place","address":{"addressRegion":"Texas"}},"jobLocationType":"TELECOMMUTE"}
]}
</script></body></html>`;
  const parsed = jobsMod.parseJsonLdPostings(ldHtml, 'https://fixco.example/careers');
  check(
    'jsonld: board-URL and stale entries skipped, valid kept',
    parsed.length === 2 &&
      parsed[0]?.title === 'Frontend Developer' &&
      parsed[0]?.location === 'Remote, United States' &&
      // Telecommute without applicantLocationRequirements stays bare
      // Remote (review): a jobLocation place must not restrict it.
      parsed[1]?.title === 'Data Analyst' &&
      parsed[1]?.location === 'Remote',
    parsed,
  );
  const ld = await runPage(ldHtml);
  check(
    'jsonld: frontend developer found through structured data, sourceType jsonld',
    ld.leads?.length === 1 &&
      ld.leads[0]?.title === 'Frontend Developer' &&
      ld.leads[0]?.sourceType === 'jsonld' &&
      ld.leads[0]?.matchScore === 69,
    ld.leads,
  );
  check(
    'jsonld: funnel counts (loan + data analyst rejected, 3 postings seen)',
    ld.screened?.rejectedNoMatch === 2 && ld.postingsSeen === 3,
    ld,
  );

  // Sweep stats: funnel counts aggregate.
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'PageCo', website: 'https://pageco.example', domain: 'pageco.example', nameKey: 'pageco', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'NoSource Inc', website: 'https://nosource.example', domain: 'nosource.example', nameKey: 'nosource inc', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  const rawHtml = `<html><body>
<div class="job-listing"><h3>Frontend Developer</h3><p>Location: Remote</p><a href="/jobs/frontend-developer">Apply</a></div>
<div class="job-listing"><h3>Loan Analyst</h3><p>Location: Remote</p><a href="/jobs/loan-analyst">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://pageco.example/careers') {
      return { ok: true, text: async () => rawHtml };
    }
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const statsOut = await jobsMod.runFindJobs(
    { companiesCol },
    { resumeText: resume, cursor: 0, limit: 15 },
  );
  // Nov 10 location rule (Eric): a bare-'Remote' posting from a U.S.
  // company passes instead of going to review, so reviewLocation is 0
  // here — the Frontend Developer lead is ok, not review-only.
  check(
    'stats: funnel counts',
    statsOut.stats.rejectedNoMatch === 1 &&
      statsOut.stats.reviewLocation === 0 &&
      statsOut.stats.noListings === 1 &&
      statsOut.stats.unreachable === 0,
    statsOut.stats,
  );
}

async function testRound17() {
  // Batch 17 (2026-11-12 round-17 canary vs 41b96b44): Foundever
  // still 0 (skipped-time), Sitel's Retention lead is a false
  // positive (Wise, VA read blank), and Teleperformance / Alorica /
  // Omni / NexRep / Working Solutions still return nothing.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const searchMod = freshRequire(`${OUT}/render-search.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- Sitel: the location lives in the Phenom slug --------------
  // Live evidence (sitel.json): the Retention card's location span
  // was unread, so the role read blank and passed as a review lead
  // — while its own apply URL says
  // /job/Wise-Retention-Customer-Service-Associate-Virg/1372881000/.
  check(
    'round17: Phenom slug reads Wise, VA; Remote slug reads Remote; a plain title slug reads nothing',
    jobsMod.locationFromJobSlug(
      'https://jobs.foundever.com/job/Wise-Retention-Customer-Service-Associate-Virg/1372881000/?utm_source=x',
    ) === 'Wise, VA' &&
      jobsMod.locationFromJobSlug(
        'https://jobs.foundever.com/job/Remote-Remote-Customer-Service-Representative-Any/1450284100/',
      ) === 'Remote' &&
      jobsMod.locationFromJobSlug('https://portal.example/job/customer-service-representative/123/') === '' &&
      jobsMod.locationFromJobSlug('https://portal.example/job/Quality-Specialist-Remote/5001/') === '' &&
      jobsMod.locationFromJobSlug('https://portal.example/job/Dallas-Customer-Service-Representative-Tex/9/') === 'Dallas, TX',
    null,
  );
  // The live Sitel card set, mirrored: two Remote CSRs + Bilingual
  // (spans read) + Retention (no span — location from the slug).
  // Screened the way test-company screens (no isUSCompany flag):
  // the 3 remote roles are leads, Retention is location-rejected
  // with its real location read — not a fourth lead.
  const slugHtml = `<html><body>
<div class="job-list">
  <div class="job-card"><a href="/job/Remote-Remote-Customer-Service-Representative-Any/1450276400/">Remote Customer Service Representative</a><span class="location">Remote, Any Location, US</span></div>
  <div class="job-card"><a href="/job/Remote-Remote-Customer-Service-Representative-Any/1450284100/">Remote Customer Service Representative</a><span class="location">Remote, Any Location, US</span></div>
  <div class="job-card"><a href="/job/Remote-Bilingual-Customer-Service-Associate-1-Any/1448643800/">Bilingual Customer Service Associate 1</a><span class="location">Remote, Any Location, US</span></div>
  <div class="job-card"><a href="/job/Wise-Retention-Customer-Service-Associate-Virg/1372881000/">Retention Customer Service Associate</a></div>
</div>
</body></html>`;
  const slugParsed = jobsMod.parseCareersPage(slugHtml, 'https://jobs.foundever.com/go/Search-Jobs-US/9244800/');
  check(
    'round17: Retention reads Wise, VA from its slug while the 3 remote leads keep their spans',
    slugParsed.length === 4 &&
      slugParsed[3]?.title === 'Retention Customer Service Associate' &&
      slugParsed[3]?.location === 'Wise, VA' &&
      slugParsed[0]?.location === 'Remote, Any Location, US',
    slugParsed,
  );
  const slugScreened = jobsMod.screenPostings('Sitel', slugParsed, resumeText, false);
  check(
    'round17: Retention is location-rejected, not a lead; the 3 remote roles still pass',
    slugScreened.leads.length === 3 &&
      slugScreened.rejectedLocation === 1 &&
      slugScreened.rejected.some((r) => r.title === 'Retention Customer Service Associate' && r.location === 'Wise, VA' && r.reason === 'location'),
    slugScreened,
  );
  // The span hardening itself: an icon inside the location span,
  // and a <div class="location"> instead of a span — both read.
  const spanHardHtml = `<html><body>
<div class="job-list">
  <div class="job-card"><a href="/job/Dallas-Customer-Service-Representative-Tex/11/">Customer Service Representative</a><span class="job-location"><i class="fa fa-map-marker"></i> Dallas, Texas, US</span></div>
  <div class="job-card"><a href="/job/Austin-Customer-Service-Representative-Tex/12/">Customer Service Representative</a><div class="location">Austin, TX</div></div>
</div>
</body></html>`;
  const spanHardParsed = jobsMod.parseCareersPage(spanHardHtml, 'https://portal.example/careers');
  check(
    'round17: icon-nested span and div.location both read into the posting',
    spanHardParsed.length === 2 &&
      spanHardParsed[0]?.location === 'Dallas, Texas, US' &&
      spanHardParsed[1]?.location === 'Austin, TX',
    spanHardParsed,
  );

  // --- NexRep: the Paylocity list URL is the portal --------------
  const paylocityUrl =
    'https://recruiting.paylocity.com/recruiting/jobs/All/73b38a10-35d0-4c94-a004-b534bb49e176/NexRep-LLC';
  check(
    'round17: Paylocity /jobs/All/ URL is an ATS list, not a job detail',
    jobsMod.isAtsListUrl(paylocityUrl) === true &&
      jobsMod.isJobDetailUrl(paylocityUrl) === true &&
      jobsMod.isAtsListUrl('https://nexrep.com/careers/') === false &&
      jobsMod.isAtsListUrl('https://example.com/jobs/customer-service-representative') === false,
    null,
  );
  check(
    'round17: the Paylocity list outranks the marketing careers page as a render target',
    jobsMod.renderTargetScore(paylocityUrl, '') > jobsMod.renderTargetScore('https://nexrep.com/careers/', ''),
    { paylocity: jobsMod.renderTargetScore(paylocityUrl, ''), careers: jobsMod.renderTargetScore('https://nexrep.com/careers/', '') },
  );
  // End to end: the careers page links to the Paylocity portal, the
  // portal's plain HTML is a JS shell (0 postings), the render goes
  // to the portal FIRST and surfaces its 4 non-CS roles (0 leads is
  // correct — they are not CS).
  const nexrepCareersHtml = `<html><body>
<header><nav><a href="/nexrep.html">Careers at NexRep</a></nav></header>
<main><h2>Agent Opportunities</h2>
<p><a href="${paylocityUrl}">Click here to see and apply for current NexRep career opportunities</a></p></main>
</body></html>`;
  const paylocityShellHtml = `<html><body><div id="app"></div><script>/* Paylocity app shell: roles render client-side */</script></body></html>`;
  const paylocityResultsHtml = `<html><body>
<p>Results 1 – 4 of 4</p>
<div class="job-list">
  <div class="job-card"><a href="/job/Quality-Specialist-Remote/5001/">Quality Specialist</a><span class="location">Remote, US</span></div>
  <div class="job-card"><a href="/job/Resource-Specialist-Remote/5002/">Resource Specialist</a><span class="location">Remote, US</span></div>
  <div class="job-card"><a href="/job/Real-Time-Analyst-Remote/5003/">Real Time Analyst</a><span class="location">Remote, US</span></div>
  <div class="job-card"><a href="/job/Payroll-Administrator-Remote/5004/">Payroll Administrator</a><span class="location">Remote, US</span></div>
</div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://nexrep.com') return { ok: true, text: async () => nexrepCareersHtml };
    if (u === paylocityUrl) return { ok: true, text: async () => paylocityShellHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const nexrepCalls = [];
  const stubNexrep = async (url) => {
    nexrepCalls.push(url);
    if (url === paylocityUrl) {
      return { html: paylocityResultsHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url };
    }
    return { html: '<html><body>No careers here.</body></html>', searchOutcome: 'no-form', searchMs: 100, renderedUrl: url };
  };
  const nexrep = await jobsMod.searchCompanyJobs(
    { name: 'NexRep', website: 'https://nexrep.com', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubNexrep },
  );
  check(
    'round17: NexRep renders the Paylocity portal first and surfaces its 4 roles (0 leads, correct)',
    nexrepCalls.length >= 1 &&
      nexrepCalls[0] === paylocityUrl &&
      nexrep.renderTargets[0]?.url === paylocityUrl &&
      nexrep.postingsSeen === 4 &&
      nexrep.leads.length === 0,
    { calls: nexrepCalls, targets: nexrep.renderTargets, postings: nexrep.postingsSeen, leads: nexrep.leads.length },
  );

  // --- Teleperformance: a fast render death is free --------------
  // The jobs portal RSTs the render in ~180ms (live canary). The
  // retry must fire on the SAME target without consuming budget,
  // and fast deaths on the /careers + /jobs guesses must not spend
  // the budget either — the loop has to reach the apex homepage
  // (which carries the list) inside a max-2 budget.
  const tpListHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<div class="job-listing"><h3>Member Services Representative</h3><p>Location: Remote</p><a href="/jobs/member-services-representative">Apply</a></div>
<div class="job-listing"><h3>Call Center Agent</h3><p>Location: Remote</p><a href="/jobs/call-center-agent">Apply</a></div>
</body></html>`;
  const tpTeaserHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://jobs.tp.example' || u === 'https://jobs.tp.example/careers' || u === 'https://jobs.tp.example/jobs') {
      throw new Error('RST');
    }
    if (u === 'https://tp.example') {
      return { ok: true, text: async () => `<html><body><input name="keyword" placeholder="Search by Keyword"><a href="/en-us/careers/job-opportunities/">See all jobs</a></body></html>` };
    }
    if (u === 'https://tp.example/en-us/careers/job-opportunities/') return { ok: true, text: async () => tpTeaserHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const tpCalls = [];
  const stubTp = async (url) => {
    tpCalls.push(url);
    if (url === 'https://tp.example/en-us/careers/job-opportunities/') {
      return { html: tpListHtml, searchOutcome: 'has-listings', searchMs: 300, renderedUrl: url };
    }
    // A fast transport death: no HTML, render-failed, ~0ms.
    return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: '', renderError: 'render-failed' };
  };
  const tp = await jobsMod.searchCompanyJobs(
    { name: 'TP Retry Co', website: 'https://jobs.tp.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubTp, renderBudget: { used: 0, max: 2 } },
  );
  check(
    'round17: fast render deaths are free — same-target retries fire, the loop reaches the late opportunities page inside a max-2 budget',
    tpCalls.length === 5 &&
      tpCalls[0] === 'https://jobs.tp.example' &&
      tpCalls[1] === 'https://jobs.tp.example' &&
      tpCalls[2] === 'https://tp.example' &&
      tpCalls[3] === 'https://tp.example' &&
      tpCalls[4] === 'https://tp.example/en-us/careers/job-opportunities/' &&
      tp.postingsSeen === 3 &&
      tp.leads.length >= 2,
    { calls: tpCalls, postings: tp.postingsSeen, leads: tp.leads.length },
  );
  check(
    'round17: every fast death is recorded with its render-failed error',
    tp.renderAttempts.length === 5 &&
      tp.renderAttempts[0]?.error === 'render-failed' &&
      tp.renderAttempts[1]?.error === 'render-failed' &&
      tp.renderAttempts[0]?.target === tp.renderAttempts[1]?.target &&
      tp.renderAttempts[2]?.target === tp.renderAttempts[3]?.target,
    tp.renderAttempts,
  );

  // --- Working Solutions: the jobs homepage outranks its blog ----
  // The walk misread a blog post on the jobs homepage as its only
  // posting (a teaser), and the old -10 penalty pushed the homepage
  // below its own /blog/ and /category/ pages — the render went to
  // the blog and harvested a scam-warning post (live canary). The
  // teaser carries no penalty now, and blog/category paths are
  // never render targets at all.
  check(
    'round17: blog and category paths are junk render targets',
    jobsMod.isJunkRenderPath('https://jobs.workingsolutions.com/blog/') === true &&
      jobsMod.isJunkRenderPath('https://jobs.workingsolutions.com/category/company-news/') === true &&
      jobsMod.isJunkRenderPath('https://jobs.workingsolutions.com/') === false &&
      jobsMod.isJunkRenderPath('https://www.workingsolutions.com/careers') === false,
    null,
  );
  const wsHomeHtml = `<html><body>
<header><nav><a href="https://jobs.ws.example/">Looking for Remote Agent Jobs?</a></nav>
<form action="/" method="get" role="search"><input type="search" name="s" placeholder="Search"><button type="submit">Search</button></form></header>
<main><h1>Working Solutions</h1></main>
</body></html>`;
  const wsJobsHtml = `<html><body>
<header><h1>Remote Agent Jobs</h1>
<a href="https://jobs.ws.example/blog/">Read our blog for job search tips</a>
<a href="https://jobs.ws.example/category/company-news/">Company news about jobs</a></header>
<div class="job-list">
  <div class="job-card"><a href="/blog/how-to-spot-a-recruitment-scam">How to spot a recruitment scam</a><span class="location">Remote, US</span></div>
</div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://www.ws.example') return { ok: true, text: async () => wsHomeHtml };
    if (u === 'https://jobs.ws.example/') return { ok: true, text: async () => wsJobsHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const wsCalls = [];
  const stubWs = async (url) => {
    wsCalls.push(url);
    return { html: '', searchOutcome: 'no-form', searchMs: 100, renderedUrl: url };
  };
  const ws = await jobsMod.searchCompanyJobs(
    { name: 'Working Solutions', website: 'https://www.ws.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubWs, renderBudget: { used: 0, max: 2 } },
  );
  check(
    'round17: the jobs homepage is the first render target and no blog/category page is a target at all',
    ws.renderTargets.length >= 1 &&
      ws.renderTargets[0]?.url === 'https://jobs.ws.example/' &&
      !ws.renderTargets.some((t) => t.url.includes('/blog/') || t.url.includes('/category/')) &&
      wsCalls[0] === 'https://jobs.ws.example/',
    { targets: ws.renderTargets, calls: wsCalls },
  );

  // --- Gate resolver: nav links are not openers ------------------
  // Live evidence (omni-interactions.json): the resolver clicked
  // "Meet Our Leadership Team" as a gate opener and the render
  // ended on the leadership page. A bare "Category" button did the
  // same on Working Solutions' blog page.
  const mkGateButton = (over) => ({
    kind: 'button', index: 0, label: '', ariaLabel: '', href: '', containerRole: '', containerClass: false,
    role: 'button', visible: true, options: [], ...over,
  });
  check(
    'round17: "Meet Our Leadership Team" is NOT a gate opener; "Select your country" still is',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'Meet Our Leadership Team', href: 'https://portal.example/leadership' }),
          mkGateButton({ index: 1, label: 'Select your country' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/corporate-careers/',
    )?.label === 'Select your country',
    null,
  );
  check(
    'round17: a page with only nav/blog controls has no gate opener',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'Meet Our Leadership Team', href: 'https://portal.example/leadership' }),
          mkGateButton({ index: 1, label: 'Category', type: 'button' }),
          mkGateButton({ index: 2, label: 'Join Our Talent Network', href: 'https://portal.example/join' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/corporate-careers/',
    ) === null,
    null,
  );
  check(
    'round17: "Department" and "Language" are still gate openers',
    searchMod.selectGateAction(
      { controls: [mkGateButton({ index: 0, label: 'Department' })] },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.target === 'open' &&
      searchMod.selectGateAction(
        { controls: [mkGateButton({ index: 0, label: 'Language' })] },
        'customer service',
        false,
        'https://portal.example/careers',
      )?.target === 'open',
    null,
  );

  // --- Post-gate listings: one link is not a list ----------------
  // A gate pick that lands on a page with exactly one job-looking
  // link and no results count must NOT read as 'searched': that is
  // a nav link on the wrong page, and the render loop must retry
  // the next target (Omni: the leadership page's "See open roles").
  // The FakePage plumbing below is the same shape as the
  // tryPortalSearch gate tests in testPortalSearch.
  const mkInput = (over) => ({
    index: 0, type: 'text', name: '', id: '', placeholder: '', ariaLabel: '', role: '', cls: '', title: '', labelText: '', describedBy: '', formIndex: 0, visible: true, top: 0, ...over,
  });
  const mkButton = (over) => ({
    index: 0, text: '', ariaLabel: '', title: '', type: 'submit', formIndex: 0, visible: true, top: 0, ...over,
  });
  class FakePage2 {
    constructor(opts = {}) {
      this._url = opts.url || 'https://portal.example/corporate-careers/';
      this.scanResult = opts.scanResult || { inputs: [], buttons: [], forms: [] };
      this.countQueue = [...(opts.counts || [])];
      this.onGateClick = opts.onGateClick || null;
      this.gateScan = opts.gateScan || { controls: [] };
      this.gateClicks = 0;
      this.gateLabels = [];
      this.buttonClicks = 0;
      this.pressedKeys = [];
      this.currentTerm = '';
      const self = this;
      this.keyboard = {
        press: async (key) => {
          self.pressedKeys.push(key);
        },
        down: async () => {},
        up: async () => {},
      };
    }
    url() {
      return this._url;
    }
    setUrl(u) {
      this._url = u;
    }
    async evaluate(fn, ...args) {
      const name = fn.name || 'anon';
      if (name === 'scanSearchForm') return this.scanResult;
      if (name === 'countJobListings') {
        return this.countQueue.length > 0 ? this.countQueue.shift() : { jobLinks: 0, resultsText: false };
      }
      if (name === 'scanGateControls') return this.gateScan;
      return 1000;
    }
    async evaluateHandle(fn, ...args) {
      const isGate = String(fn).includes('gateButtonElement');
      const self = this;
      return {
        asElement: () => ({
          click: async () => {
            if (isGate) {
              const btns = (self.gateScan.controls || []).filter((c) => c.kind === 'button');
              const label = btns[args[0]]?.label ?? '';
              self.gateClicks += 1;
              self.gateLabels.push(label);
              if (self.onGateClick) self.onGateClick(label, self);
            } else {
              self.buttonClicks += 1;
            }
          },
          type: async () => {},
          evaluate: async () => {},
        }),
        dispose: async () => {},
      };
    }
  }
  const oneLinkPage = new FakePage2({
    scanResult: { inputs: [], buttons: [], forms: [] },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 1, resultsText: false },
      { jobLinks: 1, resultsText: false },
    ],
    gateScan: {
      controls: [mkGateButton({ index: 0, label: 'United States (USA)', containerRole: 'dialog' })],
    },
    onGateClick: (label, page) => {
      page.gateScan = { controls: [] };
      page.setUrl('https://portal.example/leadership');
    },
  });
  const oneLinkOutcome = await searchMod.tryPortalSearch(oneLinkPage, 'customer service', Date.now() + 30000);
  check(
    'round17: a gate pick landing on a 1-link page is no-form, not searched',
    oneLinkOutcome === 'no-form' && oneLinkPage.gateLabels[0] === 'United States (USA)',
    { outcome: oneLinkOutcome, gateLabels: oneLinkPage.gateLabels },
  );

  // --- Alorica: re-submit after a post-submit gate pick ----------
  // Live evidence (alorica.json): both submits returned 0 roles,
  // the "United States" filter was picked AFTER them, and the
  // search never ran again — so a portal that needs its filter
  // first reads as genuinely empty. The fix re-submits once after
  // a non-navigating gate pick. The FakePage models it: submits
  // land on a zero page until the US filter is picked, then the
  // re-submit lands on the results page.
  let gatePicked = false;
  const aloricaPage = new FakePage2({
    scanResult: {
      inputs: [mkInput({ index: 0, name: 'search', placeholder: 'Search jobs', formIndex: 0 })],
      buttons: [mkButton({ index: 0, text: 'Search', formIndex: 0 })],
      forms: [{ action: '/results', method: 'get' }],
    },
    counts: [
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 0, resultsText: false },
      { jobLinks: 5, resultsText: true },
    ],
    gateScan: {
      // The live bling-ai shell also carries language buttons
      // (English / French / Spanish): after the United States pick
      // they must NOT be driven as gates — a language pick after a
      // country pick switches the UI language, it does not filter
      // jobs, and the loop would otherwise click English, then
      // French, and burn the re-submit budget (D1, local round).
      controls: [
        mkGateButton({ index: 0, label: 'English' }),
        mkGateButton({ index: 1, label: 'French' }),
        mkGateButton({ index: 2, label: 'Spanish' }),
        mkGateButton({ index: 3, label: 'United States' }),
      ],
    },
    onGateClick: () => {
      gatePicked = true;
    },
  });
  // FakePage2 has no onEnter hook — wire the navigation through the
  // keyboard + button-click paths by patching the instance.
  const origKeyboard = aloricaPage.keyboard;
  aloricaPage.keyboard = {
    press: async (key) => {
      origKeyboard.press(key);
      if (key === 'Enter') {
        if (gatePicked) aloricaPage.setUrl('https://portal.example/careers/results');
        else if (aloricaPage.currentTerm) aloricaPage.setUrl('https://portal.example/careers/zero?q=service');
        else aloricaPage.setUrl('https://portal.example/careers/zero');
      }
    },
    down: async () => {},
    up: async () => {},
  };
  // The input handle's type() records the term on the page.
  const origHandle = aloricaPage.evaluateHandle.bind(aloricaPage);
  aloricaPage.evaluateHandle = async (fn, ...args) => {
    const handle = await origHandle(fn, ...args);
    const el = handle.asElement();
    const origType = el.type.bind(el);
    el.type = async (text) => {
      aloricaPage.currentTerm = text;
      return origType(text);
    };
    return { asElement: () => el, dispose: handle.dispose };
  };
  const aloricaOutcome = await searchMod.tryPortalSearch(
    aloricaPage,
    'customer service',
    Date.now() + 30000,
    () => {},
    (label) => {},
    (label) => {},
  );
  check(
    'round17: after a post-submit US pick, the search re-runs and finds listings',
    aloricaOutcome === 'searched' &&
      gatePicked === true &&
      JSON.stringify(aloricaPage.gateLabels) === JSON.stringify(['United States']),
    { outcome: aloricaOutcome, gateLabels: aloricaPage.gateLabels, gatePicked },
  );
}

async function testRound18() {
  // Batch 18 (2026-11-12 round-18 canary vs 59d112cb): Omni's gate
  // clicked a blog article title, Working Solutions' gate clicked an
  // FAQ question, NexRep's render tail drifted to a register page,
  // and Teleperformance / Working Solutions list markup parses to 0.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const searchMod = freshRequire(`${OUT}/render-search.cjs`);
  const tcMod = freshRequire(`${OUT}/test-company.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- Opener shape guard: headlines/questions are not openers ---
  // Live evidence (omni-interactions.json, working-solutions.json):
  // "What Does 'Choose Your Schedule' Mean at Omni?" (8 words,
  // starts What) and "CAN I APPLY IF I LIVE IN A COUNTRY OTHER THAN
  // THE UNITED STATES OR CANADA?" (15 words, starts Can) both
  // matched the opener words and navigated the render onto an
  // article/FAQ page.
  const mkGateButton = (over) => ({
    kind: 'button', index: 0, label: '', ariaLabel: '', href: '', containerRole: '', containerClass: false,
    role: 'button', visible: true, options: [], ...over,
  });
  check(
    'round18: an 8-word blog title starting with What is NOT an opener; "Select your country" still is',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'What Does “Choose Your Schedule” Mean at Omni?', href: 'https://portal.example/gba/what-does-choose-your-schedule-mean-at-omni/' }),
          mkGateButton({ index: 1, label: 'Select your country' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/',
    )?.label === 'Select your country',
    null,
  );
  check(
    'round18: a 15-word FAQ question starting with Can is NOT an opener; "Select your country" still is',
    searchMod.selectGateAction(
      {
        controls: [
          mkGateButton({ index: 0, label: 'HOW DO I APPLY TO WORKING SOLUTIONS?' }),
          mkGateButton({ index: 1, label: 'CAN I APPLY IF I LIVE IN A COUNTRY OTHER THAN THE UNITED STATES OR CANADA?' }),
          mkGateButton({ index: 2, label: 'WHAT IS WORKING SOLUTIONS?' }),
          mkGateButton({ index: 3, label: 'Select your country' }),
        ],
      },
      'customer service',
      false,
      'https://portal.example/jobs/',
    )?.label === 'Select your country',
    null,
  );
  check(
    'round18: "Find a job in your country" (exactly 6 words) is still an opener; a 7-word imperative is not',
    searchMod.selectGateAction(
      { controls: [mkGateButton({ index: 0, label: 'Find a job in your country' })] },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.target === 'open' &&
      searchMod.selectGateAction(
        { controls: [mkGateButton({ index: 0, label: 'Choose your location to see jobs near you' })] },
        'customer service',
        false,
        'https://portal.example/careers',
      ) === null,
    null,
  );
  check(
    'round18: "Choose your country" and "Department" are still openers',
    searchMod.selectGateAction(
      { controls: [mkGateButton({ index: 0, label: 'Choose your country' })] },
      'customer service',
      false,
      'https://portal.example/careers',
    )?.target === 'open' &&
      searchMod.selectGateAction(
        { controls: [mkGateButton({ index: 0, label: 'Department' })] },
        'customer service',
        false,
        'https://portal.example/careers',
      )?.target === 'open',
    null,
  );

  // --- Site search is not a job search (round 18) -----------------
  // Omni's corporate-careers page carries a header site search
  // (form action="/", placeholder "Search jobs"); the +5 put it
  // ahead of the /join/ portal and burned a render on a no-form
  // marketing page (2026-11-12 canary). A form whose action is the
  // site root earns no portal credit; the same form with a results
  // action still does, and a bare input with no form is untouched.
  const siteSearchHtml = `<html><body><form action="/" method="get"><input type="search" name="s" placeholder="Search jobs"><button>Search</button></form></body></html>`;
  const jobSearchHtml = `<html><body><form action="/search" method="get"><input type="search" name="s" placeholder="Search jobs"><button>Search</button></form></body></html>`;
  const bareSearchHtml = `<html><body><input type="search" name="s" placeholder="Search jobs"></body></html>`;
  check(
    'round18: a site-search form (action="/") earns no portal credit; a results-action form and a bare input still do',
    jobsMod.portalContentScore(siteSearchHtml) === 0 &&
      jobsMod.portalContentScore(jobSearchHtml) === 5 &&
      jobsMod.portalContentScore(bareSearchHtml) === 5,
    {
      site: jobsMod.portalContentScore(siteSearchHtml),
      job: jobsMod.portalContentScore(jobSearchHtml),
      bare: jobsMod.portalContentScore(bareSearchHtml),
    },
  );

  // --- isJunkTitle: talent-pool CTAs are not roles ---------------
  // Live evidence (nexrep.json): "Share Your Information" parsed as
  // a posting and inflated postingsSeen to 4.
  check(
    'round18: "Share Your Information" / "Introduce Yourself" / "Submit Your Application" are junk; real roles are not',
    jobsMod.isJunkTitle('Share Your Information') === true &&
      jobsMod.isJunkTitle('Introduce Yourself') === true &&
      jobsMod.isJunkTitle('Submit Your Application') === true &&
      jobsMod.isJunkTitle('Customer Support Specialist') === false &&
      jobsMod.isJunkTitle('SharePoint Administrator') === false &&
      jobsMod.isJunkTitle('Quality Specialist') === false,
    null,
  );

  // --- Render loop: stop after has-listings + all-no-match --------
  // Live evidence (nexrep.json): the Paylocity list rendered
  // 'has-listings' with its 4 roles surfaced (all no-match), and the
  // loop spent its second render on the careers page, whose gate
  // drifted to a register form. A page that reported 'has-listings'
  // IS the list — the loop must stop there. A page that reported any
  // other outcome with all-no-match postings must still continue
  // (Teleperformance's values page, which reported 'no-form').
  const shellHtml = '<html><body><div id="root"></div></body></html>';
  const nonCsHtml = `<html><body>
<div class="job-listing"><h3>Quality Specialist</h3><p>Location: Remote</p><a href="/jobs/quality-specialist">Apply</a></div>
<div class="job-listing"><h3>Resource Specialist</h3><p>Location: Remote</p><a href="/jobs/resource-specialist">Apply</a></div>
<div class="job-listing"><h3>Real Time Analyst</h3><p>Location: Remote</p><a href="/jobs/real-time-analyst">Apply</a></div>
<div class="job-listing"><h3>Payroll Administrator</h3><p>Location: Remote</p><a href="/jobs/payroll-administrator">Apply</a></div>
</body></html>`;
  const csHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => shellHtml });
  let calls = [];
  const stubHasListings = async (url) => {
    calls.push(url);
    return { html: nonCsHtml, searchOutcome: 'has-listings', searchMs: 200, renderedUrl: url };
  };
  const stopped = await jobsMod.searchCompanyJobs(
    { name: 'Stop Co', website: 'https://stop.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubHasListings, renderBudget: { used: 0, max: 2 } },
  );
  check(
    'round18: has-listings + all-no-match stops after one render (no second target spent)',
    calls.length === 1 &&
      stopped.searchOutcome === 'has-listings' &&
      stopped.postingsSeen === 4 &&
      stopped.leads.length === 0 &&
      stopped.renderAttempts.length === 1 &&
      stopped.sourcePage === 'https://stop.example/careers',
    { calls, searchOutcome: stopped.searchOutcome, postingsSeen: stopped.postingsSeen, attempts: stopped.renderAttempts },
  );
  calls = [];
  const stubSearched = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { html: nonCsHtml, searchOutcome: 'searched', searchMs: 200, renderedUrl: url };
    return { html: csHtml, searchOutcome: 'searched', searchMs: 200, renderedUrl: url };
  };
  const continued = await jobsMod.searchCompanyJobs(
    { name: 'Continue Co', website: 'https://continue.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubSearched, renderBudget: { used: 0, max: 2 } },
  );
  check(
    'round18: searched + all-no-match still tries the next target and finds the role (values-page rule)',
    calls.length === 2 && continued.leads.length === 1 && continued.searchOutcome === 'searched',
    { calls, leads: continued.leads },
  );

  // --- Probe outline: the detector/extractor gap, made visible ----
  // A TP-shaped list the strategies DO parse, and a shell the
  // extractor finds nothing on: the outline must show the anchors
  // and containers in the first case and an empty parse in the second.
  const tpShapedHtml = `<html><body>
<p>Results 1 – 10 of 34</p>
<div class="job-tiles">
  <div class="job-tile"><a class="job-tile-link" href="/en-us/careers/job-opportunities/customer-service-representative/">Customer Service Representative</a><span class="location">Remote, US</span></div>
  <div class="job-tile"><a class="job-tile-link" href="/en-us/careers/job-opportunities/bilingual-customer-service-associate/">Bilingual Customer Service Associate</a><span class="location">Remote, US</span></div>
</div>
<script>window.__DATA__ = {"jobs": [{"title": "Customer Service Representative"}]};</script>
</body></html>`;
  const tpOutline = tcMod.buildMarkupOutline(tpShapedHtml, 'https://tp.example/en-us/careers/job-opportunities/');
  check(
    'round18: probe outline lists the job anchors + containers + count line on a parseable list',
    tpOutline.anchorCount === 2 &&
      tpOutline.detailAnchors.length === 2 &&
      tpOutline.containers.some((c) => /job-tiles/.test(c.cls)) &&
      tpOutline.countLines.length >= 1 &&
      tpOutline.parsedPostings === 2 &&
      tpOutline.scriptHint.length > 0,
    tpOutline,
  );
  const emptyOutline = tcMod.buildMarkupOutline(
    '<html><body><h1>Careers</h1><p>Welcome to our team page.</p></body></html>',
    'https://empty.example/careers',
  );
  check(
    'round18: probe outline is empty on a page with no job markup',
    emptyOutline.anchorCount === 0 &&
      emptyOutline.detailLinkCount === 0 &&
      emptyOutline.parsedPostings === 0 &&
      emptyOutline.containers.length === 0,
    emptyOutline,
  );
  // Probe branch wiring: with the render disabled (this suite), the
  // probe returns render-null instead of a markup outline.
  const resProbe = mkRes();
  await tcMod.default(
    mkReq('POST', {
      company: { name: 'Probe Co', website: '', careersUrl: 'https://probe.example/careers' },
      resumeText,
      probe: true,
    }, { 'x-sync-key': 'testkey' }),
    resProbe,
  );
  check(
    'round18: probe mode answers with probe:true + render-null when the render is disabled',
    resProbe.body?.probe === true && resProbe.body?.renderError === 'render-null' && resProbe.body?.markup === null,
    resProbe.body,
  );
}

async function testRound18b() {
  // Batch 18b (2026-11-12, live probe vs 4181351a): TP's opportunities
  // page renders 'has-listings' but the extractor parsed 0 — its job
  // list is iCIMS apply-link cards (anchor text "APPLY NOW", title
  // only in the URL slug). Strategy F derives the title from the slug,
  // and isJobDetailUrl now reads the iCIMS /jobs/<id>/<slug>/job shape
  // (the trailing '/job' tripped the list-path veto). 'expert' joins
  // the role words: TP titles its reps 'Customer Service Expert'.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  const icimsHtml = `<html><body>
<div class="card"><a class="w-100 h-100" href="https://careerseng-teleperformance.icims.com/jobs/80062/application-process/job?mode=job">APPLY NOW</a></div>
<div class="card"><a class="w-100 h-100" href="https://careerseng-teleperformance.icims.com/jobs/88263/customer-expert---nbs-fraud/job?mode=job">APPLY NOW</a></div>
<div class="card"><a class="w-100 h-100" href="https://careerseng-teleperformance.icims.com/jobs/80868/customer-service-expert/job?mode=job">APPLY NOW</a></div>
<div class="card"><a class="w-100 h-100" href="https://careerseng-teleperformance.icims.com/jobs/92916/zaf-hr-business-partner-gq-pe-%281227%29/job?mode=job">APPLY NOW</a></div>
</body></html>`;
  const parsed = jobsMod.parseCareersPage(
    icimsHtml,
    'https://www.tp.com/en-us/careers/job-opportunities/?page=0',
  );
  check(
    'round18b: Strategy F parses all 4 iCIMS apply-link cards with slug-derived titles',
    parsed.length === 4 &&
      parsed.some((p) => p.title === 'Customer Service Expert') &&
      parsed.some((p) => p.title === 'Customer Expert Nbs Fraud') &&
      parsed.some((p) => p.title === 'Application Process') &&
      parsed.some((p) => p.title === 'Zaf Hr Business Partner Gq Pe'),
    parsed.map((p) => p.title),
  );
  const screened = jobsMod.screenPostings('Teleperformance', parsed, resumeText, true);
  check(
    'round18b: the TP list yields Customer Service Expert at 60 (Customer Expert is a 55 near-miss, the other two reject)',
    screened.leads.length === 2 &&
      screened.leads.some((l) => l.title === 'Customer Service Expert' && l.matchScore === 60) &&
      screened.leads.some((l) => l.title === 'Customer Expert Nbs Fraud' && l.matchScore === 55) &&
      screened.rejectedNoMatch === 2,
    { leads: screened.leads.map((l) => [l.title, l.matchScore]), rejectedNoMatch: screened.rejectedNoMatch },
  );
  check(
    'round18b: titleFromJobSlug reads the iCIMS role slug and returns empty for a bare id or a category slug',
    jobsMod.titleFromJobSlug('https://careerseng-teleperformance.icims.com/jobs/80868/customer-service-expert/job') ===
      'Customer Service Expert' &&
      jobsMod.titleFromJobSlug('https://example.com/jobs/12345/') === '' &&
      jobsMod.titleFromJobSlug('https://example.com/en-us/careers/jamaica/') === '' &&
      jobsMod.titleFromJobSlug('https://example.com/jobs/123/job') === '',
    null,
  );
  check(
    'round18b: isJobDetailUrl reads /jobs/<id>/<slug>/job as a detail but still vetoes a bare /jobs/<id>/job and a list page',
    jobsMod.isJobDetailUrl('https://careerseng-teleperformance.icims.com/jobs/80868/customer-service-expert/job?mode=job') === true &&
      jobsMod.isJobDetailUrl('https://example.com/jobs/123/job') === false &&
      jobsMod.isJobDetailUrl('https://example.com/jobs/job') === false &&
      jobsMod.isJobDetailUrl('https://example.com/search-jobs&p=2') === false,
    null,
  );
  // Strategy F negatives: a CTA link that is not a job detail, and a
  // CTA link whose slug is a bare id, parse to nothing.
  const negHtml = `<html><body>
<div><a href="https://example.com/about/apply">APPLY NOW</a></div>
<div><a href="https://example.com/jobs/12345/">APPLY NOW</a></div>
</body></html>`;
  check(
    'round18b: Strategy F ignores a CTA link to a non-detail URL and one to a bare-id URL',
    jobsMod.parseCareersPage(negHtml, 'https://example.com/careers').length === 0,
    jobsMod.parseCareersPage(negHtml, 'https://example.com/careers'),
  );
  // The 'expert' gate: a CS word + expert is a role; an expert title
  // with no CS word is not CS work.
  const gateParsed = jobsMod.parseCareersPage(
    `<html><body>
<div class="job-listing"><h3>Customer Service Expert</h3><a href="/jobs/customer-service-expert">Apply</a></div>
<div class="job-listing"><h3>Fraud Expert</h3><a href="/jobs/fraud-expert">Apply</a></div>
</body></html>`,
    'https://example.com/careers',
  );
  const gateScreened = jobsMod.screenPostings('Gate Co', gateParsed, resumeText, true);
  check(
    'round18b: "Customer Service Expert" passes the CS gate, "Fraud Expert" does not',
    gateScreened.leads.length === 1 &&
      gateScreened.leads[0].title === 'Customer Service Expert' &&
      gateScreened.rejectedNoMatch === 1,
    { leads: gateScreened.leads.map((l) => l.title), rejectedNoMatch: gateScreened.rejectedNoMatch },
  );
}

async function testPaginationAndSearchScan() {
  // Pagination: a real list page that links "Next" is followed with
  // plain fetches (TalentBrew: 8/page over 38 pages; Concentrix JDQ:
  // 10/page) — up to 3 extra pages, stopping on an empty page or a
  // cycle. The search-scan summary rides the result so a live
  // no-form can be diagnosed.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText = 'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const page1 = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
<a class="next" href="/jobs&amp;p=2" rel="nofollow">Next</a>
</body></html>`;
  const page2 = `<html><body>
<div class="job-listing"><h3>Customer Support Representative</h3><p>Location: Remote</p><a href="/jobs/customer-support-representative">Apply</a></div>
<a class="next" href="/jobs?p=3" rel="nofollow">Next</a>
</body></html>`;
  const page3 = `<html><body><p>No jobs on this page.</p></body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://pageco.example') return { ok: true, text: async () => page1 };
    // The entity-decoded Next target is /jobs&p=2 (TalentBrew's own
    // markup renders &amp;p=2) — NOT /jobs?p=2.
    if (u === 'https://pageco.example/jobs&p=2') return { ok: true, text: async () => page2 };
    if (u === 'https://pageco.example/jobs?p=3') return { ok: true, text: async () => page3 };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const paged = await jobsMod.searchCompanyJobs(
    { name: 'PageCo', website: 'https://pageco.example', careersUrl: '', isUSCompany: true },
    resumeText,
  );
  check(
    'pagination: Next link followed, both pages counted, empty page stops the walk',
    paged.postingsSeen === 2 &&
      paged.leads.length === 2 &&
      paged.leads[0]?.title === 'Customer Support Specialist' &&
      paged.leads[1]?.title === 'Customer Support Representative',
    paged,
  );
  // A Next link back to a visited page ends the walk instead of
  // looping: page 2 links home, which page 1 already was.
  const cyclePage2 = `<html><body>
<div class="job-listing"><h3>Customer Support Representative</h3><p>Location: Remote</p><a href="/jobs/customer-support-representative">Apply</a></div>
<a class="next" href="/" rel="nofollow">Next</a>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://cycleco.example') return { ok: true, text: async () => page1 };
    if (u === 'https://cycleco.example/jobs&p=2') return { ok: true, text: async () => cyclePage2 };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const cycled = await jobsMod.searchCompanyJobs(
    { name: 'CycleCo', website: 'https://cycleco.example', careersUrl: '', isUSCompany: true },
    resumeText,
  );
  check(
    'pagination: a Next link back to a visited page ends the walk (no loop)',
    cycled.postingsSeen === 2 && cycled.leads.length === 2,
    cycled,
  );
  // The search-scan summary threads from the renderer to the
  // result, so a live no-form carries its diagnosis.
  const stubRenderScan = async (url) => ({
    html: `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/customer-support-specialist">Apply</a></div>
</body></html>`,
    searchOutcome: 'no-form',
    searchMs: 250,
    renderedUrl: url,
    searchScan: { inputs: 0, visibleInputs: 0, bestScore: 0, buttons: 2 },
  });
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>No careers here.</body></html>' });
  const scanned = await jobsMod.searchCompanyJobs(
    { name: 'Scan Co', website: 'https://scan.example', careersUrl: '', isUSCompany: true },
    resumeText,
    { renderPage: stubRenderScan },
  );
  check(
    'search-scan: no-form scan summary rides the result',
    scanned.searchOutcome === 'no-form' &&
      JSON.stringify(scanned.searchScan) ===
        JSON.stringify({ inputs: 0, visibleInputs: 0, bestScore: 0, buttons: 2 }),
    scanned.searchScan,
  );
}

async function testRound19() {
  // Batch 19 (2026-11-12, Eric's order 17:07 MST): server auto-add.
  // find-jobs with autoAdd: true appends qualifying leads to the board
  // itself, so headless callers (sweeps) fill the Pipeline as jobs are
  // found; the UI flow keeps its own client-side auto-add and never
  // passes the flag.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const resumeText =
    'Customer support specialist with Zendesk, chat support, and troubleshooting experience for SaaS customers';
  const supportHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div>
<div class="job-listing"><h3>Warehouse Associate</h3><p>Location: Remote</p><a href="/jobs/warehouse">Apply</a></div>
</body></html>`;
  const manualHtml = `<html><body>
<div class="job-listing"><h3>Customer Support Specialist</h3><a href="/jobs/support-manual">Apply</a></div>
</body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://autoadd.example/careers') return { ok: true, text: async () => supportHtml };
    if (u === 'https://manualco.example/careers') return { ok: true, text: async () => manualHtml };
    return { ok: true, text: async () => '<html><body>No careers here.</body></html>' };
  };
  const seedState = () => {
    const col = new FakeCollection();
    col.docs.push({
      _id: 'jobboard',
      state: { version: 1, jobs: [], masterResumes: [], settings: {} },
      updatedAt: '2026-11-12T00:00:00.000Z',
    });
    return col;
  };
  const boardJobs = (col) => col.docs.find((d) => d._id === 'jobboard')?.state?.jobs ?? [];

  // --- direct unit tests of the append itself ----------------------
  const mkLead = (over) => ({
    company: 'AutoAdd Co',
    title: 'Customer Support Specialist',
    location: 'Remote',
    locationFlag: '',
    salaryText: '',
    applyUrl: 'https://autoadd.example/jobs/1',
    description: '',
    postedDate: '',
    matchScore: 70,
    strengths: [],
    gaps: [],
    reasons: [],
    needsReview: false,
    sourceType: 'html',
    ...over,
  });
  const col0 = seedState();
  const direct = await jobsMod.autoAddLeadsToBoard(col0, [
    mkLead({}),
    mkLead({ title: 'Customer Service Representative', applyUrl: 'https://autoadd.example/jobs/2', matchScore: 65 }),
    mkLead({ title: 'Support Technician', applyUrl: 'https://autoadd.example/jobs/3', matchScore: 55 }),
    mkLead({ title: 'Customer Support Lead', applyUrl: 'https://autoadd.example/jobs/4', matchScore: 80, needsReview: true }),
    mkLead({}), // duplicate of the first lead in the same batch
  ], 'demo-customer-service');
  check('round19: only 60+ non-review leads auto-add (2 of 5)', direct.added === 2, direct);
  check(
    'round19: added leads are the 70 and the 65',
    direct.addedLeads.length === 2 &&
      direct.addedLeads.some((l) => l.title === 'Customer Support Specialist' && l.matchScore === 70) &&
      direct.addedLeads.some((l) => l.title === 'Customer Service Representative' && l.matchScore === 65),
    direct.addedLeads,
  );
  const jobs0 = boardJobs(col0);
  check('round19: board holds exactly the 2 added jobs', jobs0.length === 2, jobs0);
  const j0 = jobs0.find((j) => j.title === 'Customer Support Specialist');
  check(
    'round19: board job has the UI shape (stage new, Career Page, resume table, tailored file, no tailored text)',
    j0?.stageId === 'new' &&
      j0?.source === 'Career Page' &&
      j0?.masterResumeName === 'demo-customer-service' &&
      j0?.tailoredResumeText === '' &&
      j0?.tailoredFileName === 'Eric_AutoAdd Co_Resume' &&
      j0?.notes === 'Found via Finder.' &&
      Array.isArray(j0?.activities) &&
      typeof j0?.id === 'string' &&
      j0.id.length > 0 &&
      typeof j0?.createdAt === 'string' &&
      j0.createdAt.length > 0,
    j0,
  );
  // Re-adding the same leads is a no-op (board dedupe).
  const again = await jobsMod.autoAddLeadsToBoard(col0, [mkLead({}), mkLead({ title: 'Customer Service Representative', applyUrl: 'https://autoadd.example/jobs/2', matchScore: 65 })], 'demo-customer-service');
  check('round19: re-adding the same leads adds 0 (board dedupe)', again.added === 0 && boardJobs(col0).length === 2, again);
  // No resume label means no write at all.
  const noLabel = await jobsMod.autoAddLeadsToBoard(col0, [mkLead({ title: 'New Role', applyUrl: 'https://autoadd.example/jobs/9', matchScore: 90 })], '');
  check('round19: auto-add with no resume label writes nothing', noLabel.added === 0 && boardJobs(col0).length === 2, noLabel);
  // A concurrent writer moving the doc mid-append is retried, not lost.
  const inner = seedState();
  let failOnce = true;
  const flakyCol = {
    findOne: (f) => inner.findOne(f),
    updateOne: async (f, u, o) => {
      if (failOnce) {
        failOnce = false;
        return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
      }
      return inner.updateOne(f, u, o);
    },
  };
  const retried = await jobsMod.autoAddLeadsToBoard(flakyCol, [mkLead({})], 'demo-customer-service');
  check('round19: updatedAt guard retries after a concurrent write', retried.added === 1 && boardJobs(inner).length === 1, retried);

  // --- end-to-end through runFindJobs ------------------------------
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'AutoAdd Co', website: 'https://autoadd.example', domain: 'autoadd.example', nameKey: 'autoadd co', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-11-12T00:00:00Z' },
    { name: 'Manual Co', website: 'https://manualco.example', domain: 'manualco.example', nameKey: 'manual co', careersUrl: '', category: 'General', source: 'Manual', addedAt: '2026-11-12T00:00:00Z' },
  ]);
  const appStateCol = seedState();
  const noFlag = await jobsMod.runFindJobs(
    { companiesCol, appStateCol },
    { resumeText, cursor: 0, limit: 15 },
  );
  check(
    'round19: without the flag, leads return but nothing is written',
    noFlag.leads.length === 2 && noFlag.autoAdded === 0 && boardJobs(appStateCol).length === 0,
    { leads: noFlag.leads.map((l) => [l.title, l.matchScore, l.needsReview]), autoAdded: noFlag.autoAdded },
  );
  check(
    'round19: Manual-company lead with no location is needsReview',
    noFlag.leads.some((l) => l.company === 'Manual Co' && l.needsReview === true),
    noFlag.leads,
  );
  const withFlag = await jobsMod.runFindJobs(
    { companiesCol, appStateCol },
    { resumeText, cursor: 0, limit: 15, autoAdd: true, resumeLabel: 'demo-customer-service' },
  );
  check(
    'round19: with the flag, the 71-score lead lands on the board and the review lead does not',
    withFlag.autoAdded === 1 &&
      withFlag.stats.autoAdded === 1 &&
      withFlag.autoAddedLeads.length === 1 &&
      withFlag.autoAddedLeads[0]?.title === 'Customer Support Specialist' &&
      boardJobs(appStateCol).length === 1 &&
      boardJobs(appStateCol)[0]?.company === 'AutoAdd Co',
    { autoAdded: withFlag.autoAdded, stats: withFlag.stats.autoAdded, board: boardJobs(appStateCol) },
  );
  const rerun = await jobsMod.runFindJobs(
    { companiesCol, appStateCol },
    { resumeText, cursor: 0, limit: 15, autoAdd: true, resumeLabel: 'demo-customer-service' },
  );
  check('round19: re-running the same chunk adds 0 (no duplicates)', rerun.autoAdded === 0 && boardJobs(appStateCol).length === 1, rerun);
  const noLabelRun = await jobsMod.runFindJobs(
    { companiesCol, appStateCol },
    { resumeText, cursor: 0, limit: 15, autoAdd: true },
  );
  check('round19: flag without a resume label adds nothing', noLabelRun.autoAdded === 0 && boardJobs(appStateCol).length === 1, noLabelRun);
}

async function testRound20() {
  // Batch 20 (2026-11-12): the CS gate hole + score saturation.
  // Thorn's 'Senior Support Engineer – Tooling & Automation' scored
  // 100 for the CS resume live: 'support' is both a CS-function word
  // and a role word, so the title passed the gate on 'support' +
  // 'engineer', and its ~2KB description matched 10+ resume terms.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const csResume =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  const richDesc =
    'Provide technical support and troubleshooting for customers. Answer billing questions by phone and help members with service issues.';
  // --- Gate: technical titles need a served party ------------------
  const gate = jobsMod.screenPostings(
    'Thorn',
    [
      { title: 'Senior Support Engineer - Tooling & Automation', location: 'Remote', url: 'https://example.com/jobs/1', description: richDesc, postedDate: '' },
      { title: 'Customer Support Engineer', location: 'Remote', url: 'https://example.com/jobs/2', description: '', postedDate: '' },
      { title: 'Director, Development/Volunteer Services', location: 'Remote', url: 'https://example.com/jobs/3', description: richDesc, postedDate: '' },
      { title: 'Director of Customer Service', location: 'Remote', url: 'https://example.com/jobs/4', description: '', postedDate: '' },
      { title: 'Customer Service Representative', location: 'Remote', url: 'https://example.com/jobs/5', description: 'Call members.', postedDate: '' },
      { title: 'Patient Service Representative', location: 'Remote', url: 'https://example.com/jobs/6', description: 'Call members and help.', postedDate: '' },
    ],
    csResume,
    true,
  );
  const byTitle = (t) => gate.leads.find((l) => l.title === t);
  check(
    'round20: Thorn Senior Support Engineer is rejected for the CS resume (gate, not score)',
    !byTitle('Senior Support Engineer - Tooling & Automation') &&
      gate.rejected.some((r) => r.title === 'Senior Support Engineer - Tooling & Automation' && r.reason === 'no-match'),
    gate.leads.map((l) => [l.title, l.matchScore]),
  );
  check(
    'round20: Customer Support Engineer still passes (engineer + served party) at 60',
    byTitle('Customer Support Engineer')?.matchScore === 60,
    byTitle('Customer Support Engineer')?.matchScore,
  );
  check(
    'round20: Director, Development/Volunteer Services drops out (director + no served party)',
    !byTitle('Director, Development/Volunteer Services'),
    gate.leads.map((l) => [l.title, l.matchScore]),
  );
  check(
    'round20: Director of Customer Service still passes (director + customer) at 60',
    byTitle('Director of Customer Service')?.matchScore === 60,
    byTitle('Director of Customer Service')?.matchScore,
  );
  check(
    'round20: Customer Service Representative keeps its title-heavy score (70)',
    byTitle('Customer Service Representative')?.matchScore === 70,
    byTitle('Customer Service Representative')?.matchScore,
  );
  check(
    'round20: Patient Service Representative keeps its title-heavy score (70)',
    byTitle('Patient Service Representative')?.matchScore === 70,
    byTitle('Patient Service Representative')?.matchScore,
  );
  // --- Score: description-only matches cap at 5 -------------------
  // A frontend resume must still match the Thorn engineering role
  // (the gate is CS-only), but its long description can no longer
  // saturate the score at 100: 1 title match + 5 capped description
  // matches over 8 terms = 50 + 50*6/8 = 88.
  const feResume =
    'React TypeScript JavaScript frontend developer with Storybook and design systems experience';
  const feRichDesc =
    'React TypeScript JavaScript frontend developer with Storybook design systems experience building web apps.';
  const fe = jobsMod.screenPostings(
    'Thorn',
    [
      { title: 'Senior Support Engineer - Tooling & Automation', location: 'Remote', url: 'https://example.com/jobs/1', description: feRichDesc, postedDate: '' },
      { title: 'Director of Machine Learning & AI', location: 'Remote', url: 'https://example.com/jobs/2', description: feRichDesc, postedDate: '' },
    ],
    feResume,
    true,
  );
  const feByTitle = (t) => fe.leads.find((l) => l.title === t);
  check(
    'round20: frontend x Thorn Senior Support Engineer still a lead, below 100 (88)',
    feByTitle('Senior Support Engineer - Tooling & Automation')?.matchScore === 88,
    feByTitle('Senior Support Engineer - Tooling & Automation')?.matchScore,
  );
  check(
    'round20: frontend x Thorn Director of Machine Learning & AI drops below 100 (81)',
    feByTitle('Director of Machine Learning & AI')?.matchScore === 81,
    feByTitle('Director of Machine Learning & AI')?.matchScore,
  );
  // The 100 cap still binds when a short resume really matches
  // everything: 2 title + 2 description matches over 4 terms.
  const cap = jobsMod.screenPostings(
    'Cap Co',
    [
      { title: 'Frontend Developer', location: 'Remote', url: 'https://example.com/jobs/1', description: 'React TypeScript work.', postedDate: '' },
    ],
    'React TypeScript frontend developer',
    true,
  );
  check(
    'round20: a full match on a short resume still caps at 100',
    cap.leads.length === 1 && cap.leads[0]?.matchScore === 100,
    cap.leads.map((l) => [l.title, l.matchScore]),
  );
}

async function testRound21() {
  // Batch 21 (2026-11-12): the six systemic bugs the verify-401 run
  // found (board 405 -> 265, 140 removed). Each fix is pinned below
  // against the exact evidenced case.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const libMod = freshRequire(`${OUT}/finder-lib.cjs`);
  const csResume =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';

  // --- Fix 1: test-company isUSCompany ---------------------------
  const companiesCol = new FakeCollection();
  await companiesCol.insertMany([
    { name: 'NSSF', website: 'https://nssf.org', domain: 'nssf.org', nameKey: 'nssf', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'Manual Co', website: 'https://manualco.example', domain: 'manualco.example', nameKey: 'manual co', careersUrl: '', category: 'General', source: 'Manual', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'Concentrix', website: 'https://www.concentrix.com', domain: 'concentrix.com', nameKey: 'concentrix', careersUrl: 'https://jobs.concentrix.com/job-search/', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  check(
    'round21 fix1: roster company resolves US',
    (await libMod.resolveIsUSCompany(companiesCol, { name: 'NSSF', website: 'https://nssf.org', careersUrl: '' })) === true,
  );
  check(
    'round21 fix1: Manual company does not resolve US',
    (await libMod.resolveIsUSCompany(companiesCol, { name: 'Manual Co', website: 'https://manualco.example', careersUrl: '' })) === false,
  );
  check(
    'round21 fix1: unknown company does not resolve US',
    (await libMod.resolveIsUSCompany(companiesCol, { name: 'Nobody Inc', website: 'https://nobody.example', careersUrl: '' })) === false,
  );
  check(
    'round21 fix1: jobs-subdomain careersUrl finds its company by apex domain',
    (await libMod.resolveIsUSCompany(companiesCol, { name: 'Concentrix Jobs', website: '', careersUrl: 'https://jobs.concentrix.com/job-search/' })) === true,
  );

  // --- Fix 2: aggregator domains are never a posting source -------
  check(
    'round21 fix2: LinkedIn / Indeed / MacsList are aggregators and board URLs',
    libMod.isAggregatorUrl('https://www.linkedin.com/jobs/view/123') === true &&
      libMod.isAggregatorUrl('https://www.indeed.com/jobs?q=x') === true &&
      libMod.isAggregatorUrl('https://jobs.macslist.org/job/abc') === true &&
      libMod.isBoardUrl('https://www.linkedin.com/jobs/view/123') === true,
  );
  check(
    'round21 fix2: governmentjobs.com is NOT an aggregator (municipal portal)',
    libMod.isAggregatorUrl('https://www.governmentjobs.com/careers/sanjoseca/jobs/5367151/x') === false,
  );
  check(
    'round21 fix2: LinkedIn URL is not a job detail, Greenhouse still is',
    jobsMod.isJobDetailUrl('https://www.linkedin.com/jobs/view/customer-service-representative-123456') === false &&
      jobsMod.isJobDetailUrl('https://www.linkedin.com/jobs/view/123?id=456') === false &&
      jobsMod.isJobDetailUrl('https://job-boards.greenhouse.io/datagrail/jobs/7982580003') === true,
  );
  // End to end: a careers page linking a LinkedIn apply URL parses
  // to zero postings for that card, while the same-site role on the
  // same page is kept (Shore United Bank shape).
  const boardHtml = `<html><body>
<div class="job-listing"><h3>Customer Service Representative</h3><p>Location: Remote</p><a href="https://www.linkedin.com/jobs/view/123456">Apply on LinkedIn</a></div>
<div class="job-listing"><h3>Customer Support Specialist</h3><p>Location: Remote</p><a href="/jobs/support-specialist">Apply</a></div>
</body></html>`;
  const parsedBoard = jobsMod.parseCareersPage(boardHtml, 'https://shoreunited.example');
  check(
    'round21 fix2: LinkedIn-apply link dropped at parse, same-site role kept',
    parsedBoard.length === 1 && parsedBoard[0].title === 'Customer Support Specialist',
    parsedBoard,
  );

  // --- Fix 3: title-embedded locations ---------------------------
  check(
    'round21 fix3: Location-marker titles read the place',
    jobsMod.locationFromTitle('Customer Service Self Storage Manager Location Whitestown In United States Jobs Category Customer Service') === 'Whitestown In' &&
      jobsMod.locationFromTitle('Customer Service Self Storage Manager Location Beaumont Tx United States Jobs Category Customer Service') === 'Beaumont Tx' &&
      jobsMod.locationFromTitle('Customer Service Self Storage Manager Location West Los Angeles Ca United States Jobs Category Customer Service') === 'West Los Angeles Ca',
  );
  check(
    'round21 fix3: trailing-place titles read the place',
    jobsMod.locationFromTitle('Patient Access Representative Job – Dallas, TX') === 'Dallas, TX' &&
      jobsMod.locationFromTitle('Intervie Day on 12/9 - Access Representative Opportunities (Patient Scheduling) - Boynton Beach, FL') === 'Boynton Beach, FL',
  );
  check(
    'round21 fix3: no place, no extraction',
    jobsMod.locationFromTitle('Location Manager') === '' &&
      jobsMod.locationFromTitle('Relocation Specialist') === '' &&
      jobsMod.locationFromTitle('Customer Service Representative') === '' &&
      jobsMod.locationFromTitle('Customer Service Representative, Remote') === '',
  );
  // End to end: a Public Storage-style posting (blank location,
  // Location-marker title) is rejected on location for the CS
  // resume, while a blank-location role with no place in its title
  // still passes for a U.S. company (NSSF CSR).
  const ps = jobsMod.screenPostings(
    'Public Storage',
    [
      { title: 'Customer Service Self Storage Manager Location Whitestown In United States Jobs Category Customer Service', location: '', url: 'https://publicstoragejobs.com/jobs/1', description: '', postedDate: '' },
      { title: 'Customer Service Representative', location: '', url: 'https://publicstoragejobs.com/jobs/2', description: '', postedDate: '' },
    ],
    csResume,
    true,
    ['publicstorage.com', 'publicstoragejobs.com'],
  );
  check(
    'round21 fix3: Public Storage on-site title rejected on location, blank-location role still passes',
    ps.leads.length === 1 &&
      ps.leads[0].title === 'Customer Service Representative' &&
      ps.rejectedLocation === 1,
    ps,
  );

  // --- Fix 4: on-call is a schedule, not the verb 'call' ---------
  const onCall = jobsMod.screenPostings(
    'OnCall Co',
    [
      { title: 'Environmental Services Technician-PRN on-call 2nd shift', location: 'Remote', url: 'https://example.com/jobs/1', description: '', postedDate: '' },
      { title: 'On-Call (part-time) Assessment Projects Specialist', location: 'Remote', url: 'https://example.com/jobs/2', description: '', postedDate: '' },
      { title: 'On-Call Event Customer Service Representative', location: 'Remote', url: 'https://example.com/jobs/3', description: '', postedDate: '' },
      { title: 'On-Call Registration/Answer Center Support', location: 'Remote', url: 'https://example.com/jobs/4', description: '', postedDate: '' },
      { title: 'Customer Service Representative (On-Call)', location: 'Remote', url: 'https://example.com/jobs/5', description: '', postedDate: '' },
      { title: 'Call Center Representative', location: 'Remote', url: 'https://example.com/jobs/6', description: '', postedDate: '' },
    ],
    csResume,
    true,
  );
  const ocByTitle = (t) => onCall.leads.find((l) => l.title === t);
  check(
    'round21 fix4: on-call housekeeping technician rejected (no call credit)',
    !ocByTitle('Environmental Services Technician-PRN on-call 2nd shift') &&
      onCall.rejected.some((r) => r.title === 'Environmental Services Technician-PRN on-call 2nd shift' && r.reason === 'no-match'),
    onCall.leads.map((l) => l.title),
  );
  check(
    'round21 fix4: on-call assessment specialist rejected',
    !ocByTitle('On-Call (part-time) Assessment Projects Specialist'),
    onCall.leads.map((l) => l.title),
  );
  check(
    'round21 fix4: genuine on-call CS roles survive',
    !!ocByTitle('On-Call Event Customer Service Representative') &&
      !!ocByTitle('On-Call Registration/Answer Center Support') &&
      !!ocByTitle('Customer Service Representative (On-Call)') &&
      !!ocByTitle('Call Center Representative'),
    onCall.leads.map((l) => l.title),
  );

  // --- Fix 5: category / blog pages are not postings -------------
  check(
    'round21 fix5: Support Services is a junk title, Phone Support is not',
    jobsMod.isJunkTitle('Support Services') === true &&
      jobsMod.isJunkTitle('Support services') === true &&
      jobsMod.isJunkTitle('Phone Support') === false &&
      jobsMod.isJunkTitle('Customer Service Support') === false &&
      jobsMod.isJunkTitle('Technical Customer Support') === false,
  );
  check(
    'round21 fix5: blog hosts/paths are not details',
    jobsMod.isJobDetailUrl('https://blog.providenceswedish.jobs/') === false &&
      jobsMod.isJobDetailUrl('https://www.swedish.org/blog/benefits-that-support-you') === false,
  );
  check(
    'round21 fix5: category title + URL together are not a real posting',
    jobsMod.isRealPosting('Support Services', 'https://www.bmhsc.org/careers/career-areas/support-services') === false &&
      jobsMod.isRealPosting('Support Services', 'https://www.overlakecareers.org/jobs/administrative-clerical/food-service-nutrition/facilities-trades/') === false &&
      jobsMod.isRealPosting('Support Services', 'https://jobs.hoag.org/go/Support-Services-Jobs/886100/') === false &&
      jobsMod.isRealPosting('Benefits that support you at every stage in your career', 'https://blog.providenceswedish.jobs/') === false,
  );
  // No multi-topic URL veto: a category path stacks segments, but
  // so does a real detail — TalentBrew's /en/job/<city>/<role>/<id>/
  // and Teleperformance's /careers/job-opportunities/<role>/ both
  // carry a city/category segment before the role slug, and a veto
  // on stacked segments killed them (11 pre-existing tests failed
  // in the first round-21 run). The title rule above is the fix.
  check(
    'round21 fix5: city/category + role-slug detail URLs still pass',
    jobsMod.isJobDetailUrl('https://www.ttecjobs.com/en/job/las-vegas/customer-service-representative/44028/103182764528') === true &&
      jobsMod.isJobDetailUrl('https://tp.example/en-us/careers/job-opportunities/customer-service-representative/') === true,
  );
  // End to end: a Beaufort-like category page parses to zero
  // postings — the title kills it, not the URL.
  const catHtml = `<html><body>
<div class="job-listing"><h3>Support Services</h3><a href="/careers/career-areas/support-services">View</a></div>
</body></html>`;
  check(
    'round21 fix5: category page parses to zero postings',
    jobsMod.parseCareersPage(catHtml, 'https://www.bmhsc.org').length === 0,
    jobsMod.parseCareersPage(catHtml, 'https://www.bmhsc.org'),
  );

  // --- Fix 6: gate holes in the kept set -------------------------
  // (a) Division/department suffixes name the org chart, not the
  // role: San Jose Clean Energy's energy-program managers passed
  // on 'Customer' from 'Customer Programs Division'.
  const div = jobsMod.screenPostings(
    'San Jose Clean Energy',
    [
      { title: 'Manager of Building Electrification Programs (Senior Power Resources Specialist) – Account Management, Marketing, and Customer Programs Division', location: '', url: 'https://www.governmentjobs.com/careers/sanjoseca/jobs/5367151/x', description: '', postedDate: '' },
      { title: 'Energy Account Services Specialist I/II (Power Resources Specialist I/II) – Account Services, Marketing and Communications, and Customer Programs Division', location: '', url: 'https://www.governmentjobs.com/careers/sanjoseca/jobs/5537926/x', description: '', postedDate: '' },
      { title: 'Senior Public Information Representative – Account Management, Marketing, and Customer Programs Division', location: '', url: 'https://www.governmentjobs.com/careers/sanjoseca/jobs/5478830/x', description: '', postedDate: '' },
      { title: 'Customer Service Representative – Call Center Division', location: 'Remote', url: 'https://www.governmentjobs.com/careers/sanjoseca/jobs/1', description: '', postedDate: '' },
      { title: 'Manager of Customer Programs – Operations Division', location: 'Remote', url: 'https://www.governmentjobs.com/careers/sanjoseca/jobs/2', description: '', postedDate: '' },
    ],
    csResume,
    true,
    ['sanjoseca.gov'],
  );
  const divByTitle = (t) => div.leads.find((l) => l.title === t);
  check(
    'round21 fix6: division-suffix energy roles rejected, real CS roles survive the strip',
    !divByTitle('Manager of Building Electrification Programs (Senior Power Resources Specialist) – Account Management, Marketing, and Customer Programs Division') &&
      !divByTitle('Energy Account Services Specialist I/II (Power Resources Specialist I/II) – Account Services, Marketing and Communications, and Customer Programs Division') &&
      !divByTitle('Senior Public Information Representative – Account Management, Marketing, and Customer Programs Division') &&
      !!divByTitle('Customer Service Representative – Call Center Division') &&
      !!divByTitle('Manager of Customer Programs – Operations Division'),
    div.leads.map((l) => l.title),
  );
  // (b) 'teacher' is no longer a role word: the teaching role
  // passed on 'teacher' + 'service'.
  const teacher = jobsMod.screenPostings(
    'Nonprofit Association of Washington',
    [
      { title: 'Certified Teacher of the Visually Impaired and Orientation/Mobility Specialist - Washington Service', location: '', url: 'https://nonprofit.example/jobs/1', description: '', postedDate: '' },
    ],
    csResume,
    true,
  );
  check(
    'round21 fix6: Certified Teacher no longer passes the gate on teacher + service',
    teacher.leads.length === 0,
    teacher.leads,
  );
  // (c) Apply-host discipline: a posting on another org's site is
  // that org's job, not the roster company's.
  check(
    'round21 fix6: apply-host allowlist',
    jobsMod.isAllowedApplyHost('https://disasterphilanthropy.org/about/careers/manager-advisory-services/', ['peakgrantmaking.org']) === false &&
      jobsMod.isAllowedApplyHost('https://akoyago.com/careers/technical-support-representative-tier-i-job-description/', ['peakgrantmaking.org']) === false &&
      jobsMod.isAllowedApplyHost('https://icma.org/job-posts/149864', ['pml.org']) === false &&
      jobsMod.isAllowedApplyHost('https://www.governmentjobs.com/careers/sanjoseca/jobs/5367151/x', ['sanjoseca.gov']) === true &&
      jobsMod.isAllowedApplyHost('https://jobs.concentrix.com/job/customer-support-specialist', ['careers.concentrix.com']) === true &&
      jobsMod.isAllowedApplyHost('https://jobs.wisc.edu/jobs/client-services-specialist', ['wcer.wisc.edu']) === true &&
      jobsMod.isAllowedApplyHost('https://umchealthsystem.wd1.myworkdayjobs.com/en-US/External/job/x', ['umchealthsystem.org']) === true &&
      jobsMod.isAllowedApplyHost('https://recruitingbypaycor.com/x', ['nexrep.com']) === true &&
      jobsMod.isAllowedApplyHost('https://halvik.isolvedhire.com/iframe/1894977.html', ['halvik.com']) === true &&
      jobsMod.isAllowedApplyHost('https://www.jobs.virginia.gov/jobs/x', ['vadars.org']) === true &&
      jobsMod.isAllowedApplyHost('https://www.linkedin.com/jobs/view/123', ['shoreunitedbank.com']) === false &&
      jobsMod.isAllowedApplyHost('https://testco.applytojob.com/apply/x', ['testco.com']) === true,
  );
  const attrib = jobsMod.screenPostings(
    'PEAK Grantmaking',
    [
      { title: 'Manager, Advisory Services | Center for Disaster Philanthropy', location: 'Remote', url: 'https://disasterphilanthropy.org/about/careers/manager-advisory-services/', description: '', postedDate: '' },
      { title: 'Tier I Support Representative | akoyaGO', location: 'Remote', url: 'https://akoyago.com/careers/technical-support-representative-tier-i-job-description/', description: '', postedDate: '' },
    ],
    csResume,
    true,
    ['peakgrantmaking.org'],
  );
  const pml = jobsMod.screenPostings(
    'Pennsylvania Municipal League',
    [
      { title: 'Home to Hope Program Manager - Reentry & Behavioral Health Support (Grant-Funded)', location: '', url: 'https://icma.org/job-posts/149864', description: '', postedDate: '' },
    ],
    csResume,
    true,
    ['pml.org'],
  );
  check(
    'round21 fix6: other-org jobs rejected by the apply host',
    attrib.leads.length === 0 && pml.leads.length === 0,
    { attrib: attrib.leads, pml: pml.leads },
  );
  // The PML title passes the gate on its own words — the host
  // filter is the operative fix there, so pin that too.
  const pmlNoHost = jobsMod.screenPostings(
    'Pennsylvania Municipal League',
    [
      { title: 'Home to Hope Program Manager - Reentry & Behavioral Health Support (Grant-Funded)', location: '', url: 'https://icma.org/job-posts/149864', description: '', postedDate: '' },
    ],
    csResume,
    true,
  );
  check(
    'round21 fix6: without the host list the PML title still passes the gate (host filter is the fix)',
    pmlNoHost.leads.length === 1,
    pmlNoHost.leads,
  );
  // Widget / JSON-LD postings are exempt from the host check: their
  // provenance is the company's own page (HouseRx's Greenhouse embed
  // carries a houserx.com apply URL while the company is addressed
  // by its .example stand-in). The same posting parsed off HTML is
  // still rejected.
  const widget = jobsMod.screenPostings(
    'House Rx',
    [
      { title: 'Customer Service Representative', location: 'Remote', url: 'https://www.houserx.com/careers?gh_jid=4749398005', description: '', postedDate: '', source: 'greenhouse' },
    ],
    csResume,
    true,
    ['houserx.example'],
  );
  const widgetHtml = jobsMod.screenPostings(
    'House Rx',
    [
      { title: 'Customer Service Representative', location: 'Remote', url: 'https://www.houserx.com/careers?gh_jid=4749398005', description: '', postedDate: '', source: 'html' },
    ],
    csResume,
    true,
    ['houserx.example'],
  );
  check(
    'round21 fix6: widget posting exempt from the host check, HTML posting is not',
    widget.leads.length === 1 && widgetHtml.leads.length === 0,
    { widget: widget.leads.length, html: widgetHtml.leads.length },
  );
}

async function testRound22Fix1() {
  // Round 22 fix 1 (2026-11-12): a Public Storage DETAIL page
  // produced two parses of one role — Strategy A read the located
  // posting off the job-info block (rejected on location, correct),
  // while Strategy F's slug-derived parse off the SmartRecruiters
  // APPLY NOW anchor went out with a BLANK location and scored 60,
  // so it would auto-add in the sweep. The page IS one job, so its
  // own location now carries onto blank parses from detail pages.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const csResume =
    'Customer service representative with phone support experience, technical support, troubleshooting, billing questions, and help desk work for members';
  const detailUrl =
    'https://www.publicstoragejobs.com/jobs/customer-service-self-storage-manager-location-whitestown-in-united-states-jobs-category-customer-service-744000161367179';
  const detailHtml = `<html><body>
<div class="job-info">
  <h2>Customer Service - Self Storage Manager</h2>
  <ul class="listing-details"><li>Location: Whitestown, Indiana, us</li><li>Full Time</li></ul>
  <a href="${detailUrl}">View job</a>
</div>
<div class="apply-button"><a href="https://jobs.smartrecruiters.com/PublicStorage/744000161367179-customer-service-self-storage-manager?oga=true&amp;utm_source=HireClixCS">APPLY NOW</a></div>
</body></html>`;
  const parsed = jobsMod.parseCareersPage(detailHtml, detailUrl);
  const slugParsed = parsed.find(
    (p) => p.title === 'Customer Service Self Storage Manager' && p.url.includes('smartrecruiters.com'),
  );
  check(
    'round22 fix1: Strategy F parse off a detail page carries the page location',
    !!slugParsed && slugParsed.location === 'Whitestown, Indiana, us',
    parsed,
  );
  check(
    'round22 fix1: no blank-location parse survives off a detail page',
    parsed.length > 0 && parsed.every((p) => p.location !== ''),
    parsed,
  );
  // End to end: the detail page yields 0 leads after screening —
  // every parse is rejected on the on-site location.
  const screened = jobsMod.screenPostings(
    'Public Storage',
    parsed,
    csResume,
    true,
    ['publicstorage.com', 'publicstoragejobs.com'],
  );
  check(
    'round22 fix1: Public Storage detail page yields 0 leads after screening',
    screened.leads.length === 0 && screened.rejectedLocation === parsed.length,
    screened,
  );
  // Guard: list pages are unaffected — a card with no location on a
  // list page stays blank-location (it is not one job's detail page,
  // so no page location exists to carry).
  const listHtml = `<html><body>
<div class="job-listing"><h3>Customer Service Representative</h3><p>Location: Remote</p><a href="/jobs/customer-service-representative">Apply</a></div>
<div class="job-listing"><h3>Customer Service Representative</h3><a href="/jobs/customer-service-representative-2">Apply</a></div>
</body></html>`;
  const listParsed = jobsMod.parseCareersPage(listHtml, 'https://listco.example/careers');
  check(
    'round22 fix1: list page with a location-less card stays blank-location',
    listParsed.length === 2 &&
      listParsed[0]?.location === 'Remote' &&
      listParsed[1]?.location === '',
    listParsed,
  );
  // Follow-up (2026-11-13 live): the REAL Whitestown detail page has
  // NO "Location:" line or location span in its visible HTML — the
  // place lives ONLY in the page's JSON-LD JobPosting block
  // (addressCountry "us"), which the first version missed because
  // pageLocation read locationIn(clean) only. The JSON-LD parse
  // carried "Whitestown, Indiana, us" while the APPLY NOW parse went
  // out blank at 60. A detail page whose only location is JSON-LD
  // now carries that location onto blank parses too.
  const jsonLdDetailHtml = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Customer Service - Self Storage Manager","url":"${detailUrl}","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Whitestown","addressRegion":"Indiana","addressCountry":"us"}}}</script>
</head><body>
<div class="job-info"><h2>Customer Service - Self Storage Manager</h2></div>
<div class="apply-button"><a href="https://jobs.smartrecruiters.com/PublicStorage/744000161367179-customer-service-self-storage-manager?oga=true&amp;utm_source=HireClixCS">APPLY NOW</a></div>
</body></html>`;
  const jsonLdParsed = jobsMod.parseCareersPage(jsonLdDetailHtml, detailUrl);
  // The parse off this mirror carries the page's h2 title (Strategy A
  // takes the heading and the SmartRecruiters apply link in one
  // chunk); the point is the LOCATION, not which strategy named it.
  const jsonLdSlug = jsonLdParsed.find((p) => p.url.includes('smartrecruiters.com'));
  check(
    'round22 fix1b: Strategy F parse off a JSON-LD-only detail page carries the JSON-LD location',
    !!jsonLdSlug && jsonLdSlug.location === 'Whitestown, Indiana, us',
    jsonLdParsed,
  );
  check(
    'round22 fix1b: no blank-location parse survives off a JSON-LD-only detail page',
    jsonLdParsed.length > 0 && jsonLdParsed.every((p) => p.location !== ''),
    jsonLdParsed,
  );
  // TELECOMMUTE JSON-LD reads Remote; two JobPosting blocks read
  // nothing (a detail page has one job — several blocks prove no
  // single place, so never guess); malformed JSON-LD reads nothing.
  const remoteJsonLdHtml = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Customer Service Representative","url":"https://remote.example/jobs/1","jobLocationType":"TELECOMMUTE"}</script>
</head><body>
<div class="apply-button"><a href="https://jobs.smartrecruiters.com/RemoteCo/1-customer-service-representative">APPLY NOW</a></div>
</body></html>`;
  const remoteParsed = jobsMod.parseCareersPage(remoteJsonLdHtml, 'https://remote.example/jobs/1');
  check(
    'round22 fix1b: TELECOMMUTE JSON-LD on a detail page reads Remote',
    remoteParsed.length > 0 && remoteParsed.every((p) => p.location === 'Remote'),
    remoteParsed,
  );
  const twoJsonLdHtml = `<html><head>
<script type="application/ld+json">{"@type":"JobPosting","title":"Job One","url":"https://two.example/jobs/1","jobLocation":{"address":{"addressLocality":"Whitestown","addressRegion":"Indiana","addressCountry":"us"}}}</script>
<script type="application/ld+json">{"@type":"JobPosting","title":"Job Two","url":"https://two.example/jobs/2","jobLocation":{"address":{"addressLocality":"Austin","addressRegion":"Texas","addressCountry":"us"}}}</script>
</head><body>
<div class="apply-button"><a href="https://jobs.smartrecruiters.com/TwoCo/1-customer-service-representative">APPLY NOW</a></div>
</body></html>`;
  const twoParsed = jobsMod.parseCareersPage(twoJsonLdHtml, 'https://two.example/jobs/1');
  check(
    'round22 fix1b: two JobPosting blocks on a detail page read no page location',
    twoParsed.length > 0 && twoParsed.every((p) => p.location === ''),
    twoParsed,
  );
  const badJsonLdHtml = `<html><head>
<script type="application/ld+json">{not json</script>
</head><body>
<div class="apply-button"><a href="https://jobs.smartrecruiters.com/BadCo/1-customer-service-representative">APPLY NOW</a></div>
</body></html>`;
  const badParsed = jobsMod.parseCareersPage(badJsonLdHtml, 'https://bad.example/jobs/1');
  check(
    'round22 fix1b: malformed JSON-LD on a detail page reads no page location',
    badParsed.length > 0 && badParsed.every((p) => p.location === ''),
    badParsed,
  );
}

async function testRound22() {
  // Batch 22 (2026-11-12): cross-company applyUrl dedupe in auto-add.
  // autoAddLeadsToBoard deduped only by title+company, so the same
  // posting filed under two roster companies — the Davis Theatre
  // duplicates were the exact same postings as the verified Troy
  // University jobs — would land on the board twice. The URL dedupe
  // below sits alongside the title+company dedupe, not instead of it.
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);
  const seedState = () => {
    const col = new FakeCollection();
    col.docs.push({
      _id: 'jobboard',
      state: { version: 1, jobs: [], masterResumes: [], settings: {} },
      updatedAt: '2026-11-12T00:00:00.000Z',
    });
    return col;
  };
  const boardJobs = (col) => col.docs.find((d) => d._id === 'jobboard')?.state?.jobs ?? [];
  const mkLead = (over) => ({
    company: 'Troy University',
    title: 'Call Center Representative',
    location: 'Remote',
    locationFlag: '',
    salaryText: '',
    applyUrl: 'https://troy.example/jobs/call-center-rep',
    description: '',
    postedDate: '',
    matchScore: 70,
    strengths: [],
    gaps: [],
    reasons: [],
    needsReview: false,
    sourceType: 'html',
    ...over,
  });

  // (1) Same applyUrl under two different companies -> added ONCE.
  // Same title too (the Davis Theatre / Troy University shape), and
  // again with a different title, so the URL — not the title — is
  // what dedupes.
  const col1 = seedState();
  const cross = await jobsMod.autoAddLeadsToBoard(col1, [
    mkLead({ company: 'Troy University' }),
    mkLead({ company: 'Davis Theatre', applyUrl: 'https://troy.example/jobs/call-center-rep' }),
    mkLead({ company: 'Davis Theatre', title: 'Box Office Associate', applyUrl: 'https://troy.example/jobs/call-center-rep' }),
  ], 'demo-customer-service');
  check(
    'round22: same applyUrl under two companies adds once',
    cross.added === 1 && boardJobs(col1).length === 1 && boardJobs(col1)[0]?.company === 'Troy University',
    cross,
  );
  // The same URL already on the board blocks a later batch too.
  const crossAgain = await jobsMod.autoAddLeadsToBoard(col1, [
    mkLead({ company: 'Davis Theatre', applyUrl: 'https://troy.example/jobs/call-center-rep' }),
  ], 'demo-customer-service');
  check(
    'round22: applyUrl already on the board blocks a later batch',
    crossAgain.added === 0 && boardJobs(col1).length === 1,
    crossAgain,
  );

  // (2) The URL dedupe must not over-dedupe: distinct URLs with
  // distinct titles both add. (Same title+company with a different
  // URL still adds once — the pre-existing title+company dedupe
  // fires there, and it stays in place.)
  const col2 = seedState();
  const sameKey = await jobsMod.autoAddLeadsToBoard(col2, [
    mkLead({ applyUrl: 'https://troy.example/jobs/call-center-rep' }),
    mkLead({ applyUrl: 'https://troy.example/jobs/call-center-rep-2' }),
  ], 'demo-customer-service');
  check(
    'round22: title+company dedupe still fires for a re-posted URL',
    sameKey.added === 1 && boardJobs(col2).length === 1,
    sameKey,
  );
  const col2b = seedState();
  const distinctTitles = await jobsMod.autoAddLeadsToBoard(col2b, [
    mkLead({ title: 'Call Center Representative', applyUrl: 'https://troy.example/jobs/a' }),
    mkLead({ title: 'Customer Service Representative', applyUrl: 'https://troy.example/jobs/b' }),
  ], 'demo-customer-service');
  check(
    'round22: different URLs with different titles both add (no over-dedupe)',
    distinctTitles.added === 2 && boardJobs(col2b).length === 2,
    distinctTitles,
  );

  // (3) A URL differing only by query params / trailing slash /
  // host case counts as a duplicate.
  const col3 = seedState();
  const tracked = await jobsMod.autoAddLeadsToBoard(col3, [
    mkLead({ company: 'Troy University', applyUrl: 'https://troy.example/jobs/call-center-rep' }),
    mkLead({ company: 'Davis Theatre', applyUrl: 'https://troy.example/jobs/call-center-rep?utm_source=indeed' }),
    mkLead({ company: 'Davis Theatre', title: 'Box Office Associate', applyUrl: 'https://TROY.example/jobs/call-center-rep/?oga=true' }),
    mkLead({ company: 'Davis Theatre', title: 'Usher', applyUrl: 'https://troy.example/jobs/call-center-rep#apply' }),
  ], 'demo-customer-service');
  check(
    'round22: query params, trailing slash, host case and fragment do not defeat the URL dedupe',
    tracked.added === 1 && boardJobs(col3).length === 1,
    tracked,
  );

  // Scheme is irrelevant: the same posting over http vs https is one
  // posting (merge-time fold-in — the normalizer drops the scheme;
  // same host+path can only be the same posting).
  const col4 = seedState();
  const scheme = await jobsMod.autoAddLeadsToBoard(col4, [
    mkLead({ company: 'Troy University', applyUrl: 'https://troy.example/jobs/call-center-rep' }),
    mkLead({ company: 'Davis Theatre', applyUrl: 'http://troy.example/jobs/call-center-rep' }),
  ], 'demo-customer-service');
  check(
    'round22: http vs https variants of the same posting add once',
    scheme.added === 1 && boardJobs(col4).length === 1,
    scheme,
  );
}

async function testRound22Fix3() {
  // Round 22 fix 3 (2026-11-12): URL-slug trailing location suffix.
  // Philander Chase's two leads read blank and passed as 'no
  // location listed — US company', while their own PageUp apply
  // URLs state Gambier, OH on-site (evidence:
  // ~/workspace/jobboard/r22-live/philander-chase.json).
  const jobsMod = freshRequire(`${OUT}/find-jobs.cjs`);

  // (1) Both real Philander Chase URL shapes read Gambier, OH —
  // with the UUID tail, and without it.
  check(
    'round22 fix3: both Philander Chase PageUp slugs read Gambier, OH',
    jobsMod.locationFromJobSlug(
      'https://careers.kenyon.edu/jobs/customer-service-and-sales-associate-part-time-gambier-oh-ohio-united-states-ecbb1ca2-22bd-412d-a2f7-711e87e71a04',
    ) === 'Gambier, OH' &&
      jobsMod.locationFromJobSlug(
        'https://careers.kenyon.edu/jobs/technology-support-specialist-gambier-oh-ohio-united-states',
      ) === 'Gambier, OH',
    null,
  );
  // Abbr-only, name-only, and -usa markers read the same place.
  check(
    'round22 fix3: abbr-only, name-only, and -usa suffixes read Gambier, OH',
    jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-oh-united-states') === 'Gambier, OH' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-ohio-united-states') === 'Gambier, OH' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-oh-usa') === 'Gambier, OH',
    null,
  );
  // (2) A plain title slug with no location suffix reads nothing.
  check(
    'round22 fix3: plain title slug and marker-with-no-state read nothing',
    jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative') === '' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-united-states') === '',
    null,
  );
  // (3) A state abbreviation with NO country marker must not fire —
  // the marker is what proves the tail is a location block.
  check(
    'round22 fix3: state abbr without a country marker reads nothing',
    jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-oh') === '' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-ohio') === '',
    null,
  );
  // Disagreeing abbr + name, and a non-UUID tail after the marker,
  // both read nothing.
  check(
    'round22 fix3: disagreeing abbr/name and non-UUID tail read nothing',
    jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-oh-texas-united-states') === '' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-gambier-oh-ohio-united-states-foo') === '',
    null,
  );
  // (4) A standalone 'remote' token in the location block reads
  // Remote — with and without a state.
  check(
    'round22 fix3: remote PageUp slug reads Remote',
    jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-remote-united-states') === 'Remote' &&
      jobsMod.locationFromJobSlug('https://careers.example.edu/jobs/customer-service-representative-remote-oh-ohio-united-states') === 'Remote, OH',
    null,
  );
  // End to end (FakePage): the two mirrored Philander Chase cards
  // carry no location span, and the location comes from the slug
  // through push() — so they parse as Gambier, OH, not blank.
  const kenyonHtml = `<html><body>
<div class="job-list">
  <div class="job-card"><a href="https://careers.kenyon.edu/jobs/customer-service-and-sales-associate-part-time-gambier-oh-ohio-united-states-ecbb1ca2-22bd-412d-a2f7-711e87e71a04">Customer Service and Sales Associate, Part-Time</a></div>
  <div class="job-card"><a href="https://careers.kenyon.edu/jobs/technology-support-specialist-gambier-oh-ohio-united-states">Technology Support Specialist</a></div>
</div>
</body></html>`;
  const kenyonParsed = jobsMod.parseCareersPage(kenyonHtml, 'https://careers.pageuppeople.com/695/cw/en-us/filter/?search-keyword=');
  check(
    'round22 fix3: mirrored Philander Chase cards read Gambier, OH from the slug, not blank',
    kenyonParsed.length === 2 &&
      kenyonParsed[0]?.location === 'Gambier, OH' &&
      kenyonParsed[1]?.location === 'Gambier, OH',
    kenyonParsed.map((p) => ({ title: p.title, location: p.location })),
  );
}

await testFindCompanies();
await testFindCompaniesTransientError();
await testFindCompaniesDupeStretch();
await testWikidataPerType();
await testEdgar();
await testFailureSkip();
await testExactCounts();
await testSocialPresence();
await testWikidataSocial();
await testWebsiteUpgrade();
await testUpgradeCollision();
await testOrgKeysetPaging();
await testNeverSkip();
await testTypesKeysetPaging();
await testTypesSkipRetry();
await testBusinessKeyset();
await testBusinessKeysetTypeSkip();
await testFindJobs();
await testFindJobsNonFrontend();
await testRenderFallback();
await testPortalSearch();
await testDeferredRender();
await testRenderTargetScoring();
await testRenderRetry();
await testRejectedTelemetry();
await testJobCardAnchors();
await testRealPostingGate();
await testJunkWalkAndRender();
await testTalentBrewAndRenderError();
await testRound4();
await testRound5();
await testRound6();
await testRound7();
await testRound8();
await testRound9();
await testRound11();
await testRound17();
await testRound18();
await testRound18b();
await testRound19();
await testRound20();
await testRound21();
await testRound22Fix1();
await testRound22();
await testRound22Fix3();
await testPaginationAndSearchScan();
await testTestCompany();
await testJazzhr();
await testBusinessSiteFirst();
await testHalvik();
await testHouseRx();
await testFitReasons();
await testMatchingFixes();
await testCompaniesApi();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
