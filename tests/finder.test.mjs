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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = '/tmp/finder-test-bundles';
execSync(`mkdir -p ${OUT}`);
for (const name of ['find-companies', 'find-jobs', 'finder-lib']) {
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
  check('find-companies press 1 source label', res.body?.source === 'Wikidata', res.body);
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
    'find-companies core cursor past all sources (per-type wikidata + empty edgar)',
    cursorDoc?.sourceIndex === 2 &&
      cursorDoc?.state?.wikidata?.typeIndex === 4 &&
      JSON.stringify(cursorDoc?.state?.wikidata?.offsets) === JSON.stringify([600, 300, 300, 300]),
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
  // Rewind type 0's offset to 0 (per-type cursor shape).
  await metaCol.updateOne(
    { _id: 'find-companies' },
    { $set: { 'state.wikidata.offsets': [0, 0, 0, 0], 'state.wikidata.typeIndex': 0 } },
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
  // pages through every type — the cursor advanced past all consumed
  // work, so the button is never stuck.
  check(
    'dupe-stretch press: cursor advanced past consumed pages',
    JSON.stringify(cursorDoc?.state?.wikidata?.offsets) === JSON.stringify([600, 300, 300, 300]) &&
      cursorDoc?.sourceIndex === 2,
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
    { name: 'TestCorp', website: 'https://testcorp.com', domain: 'testcorp.com', nameKey: 'testcorp', careersUrl: 'https://boards.greenhouse.io/testcorp', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
    { name: 'NoBoard Inc', website: 'https://noboard.example', domain: 'noboard.example', nameKey: 'noboard inc', careersUrl: '', category: 'General', source: 'Wikidata', addedAt: '2026-10-29T00:00:00Z' },
  ]);
  globalThis.fetch = boardsFetchStub;
  const out = await mod.runFindJobs(
    { companiesCol },
    { resumeText: 'React TypeScript JavaScript frontend developer with Storybook and design systems experience', cursor: 0, limit: 15 },
  );
  check('find-jobs leads 1 (backend filtered)', out.leads.length === 1, out);
  check('find-jobs lead is Frontend Engineer @ TestCorp, score 100', out.leads[0]?.title === 'Frontend Engineer' && out.leads[0]?.company === 'TestCorp' && out.leads[0]?.matchScore === 100, out.leads[0]);
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
    { $set: { version: 2, sourceIndex: 1, state: { wikidata: { typeIndex: 4, offsets: [0, 0, 0, 0] } } } },
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
    async () => {
      throw new Error('wikidata should not be called');
    },
    tickerMap,
    subs,
  );
  const out = await runMod.runFindCompanies(
    { companiesCol, metaCol, fetchFn: globalThis.fetch },
    { limit: 2000 },
  );
  check('edgar: added 3 (US+website only)', out.added === 3, out);
  check('edgar: source label', out.source === 'SEC EDGAR', out);
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
    if (u.includes('query.wikidata.org')) throw new Error('WDQS down');
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
  check('failure-skip: cursor past wikidata and edgar', cursorDoc?.sourceIndex === 2, cursorDoc);
}

await testFindCompanies();
await testFindCompaniesTransientError();
await testFindCompaniesDupeStretch();
await testWikidataPerType();
await testEdgar();
await testFailureSkip();
await testFindJobs();
await testCompaniesApi();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
