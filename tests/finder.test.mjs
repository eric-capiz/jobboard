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
for (const name of ['find-companies', 'find-jobs', 'finder-lib', 'test-company']) {
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
    'find-companies core cursor past all sources (social + per-type wikidata + empty edgar + organization + keyset + types)',
    cursorDoc?.sourceIndex === 7 &&
      cursorDoc?.state?.['wikidata-social']?.comboIndex === 24 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-social']?.offsets?.slice(0, 1)) === JSON.stringify([600]) &&
      cursorDoc?.state?.wikidata?.typeIndex === 4 &&
      JSON.stringify(cursorDoc?.state?.wikidata?.offsets) === JSON.stringify([300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-social-organization']?.comboIndex === 6 &&
      JSON.stringify(cursorDoc?.state?.['wikidata-social-organization']?.offsets) === JSON.stringify([300, 300, 300, 300, 300, 300]) &&
      cursorDoc?.state?.['wikidata-organization']?.offset === 300 &&
      cursorDoc?.state?.['wikidata-organization-keyset']?.lastIri === '' &&
      cursorDoc?.state?.['wikidata-types-keyset']?.typeIndex === 9,
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
      cursorDoc?.state?.['wikidata-types-keyset']?.typeIndex === 9 &&
      cursorDoc?.sourceIndex === 7,
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
  // Scores cap at 100: a rich description matching 16 resume terms
  // would otherwise score 130.
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
  check('score caps at 100', resCap.body?.leads?.length === 1 && resCap.body?.leads[0]?.matchScore === 100, resCap.body?.leads);
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
  check('edgar: walk ends at Wikidata types keyset', out.source === 'Wikidata types keyset', out);
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
  check('keyset: source label (walk continues into types after)', out.source === 'Wikidata types keyset', out);
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
    cursorDoc?.sourceIndex === 7 &&
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
  check('types-skip-retry: added 8 (one per surviving type)', out.added === 8, out);
  check('types-skip-retry: exhausted after retry round', out.exhausted === true, out);
  check('types-skip-retry: dead type tried 3 + 3 times', type0Throws === 6, type0Throws);
  const cursorDoc = await metaCol.findOne({ _id: 'find-companies' });
  check('types-skip-retry: cursor past source', cursorDoc?.sourceIndex === 7, cursorDoc);
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
  check(
    'stats: funnel counts',
    statsOut.stats.rejectedNoMatch === 1 &&
      statsOut.stats.reviewLocation === 1 &&
      statsOut.stats.noListings === 1 &&
      statsOut.stats.unreachable === 0,
    statsOut.stats,
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
await testFindJobs();
await testFindJobsNonFrontend();
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
