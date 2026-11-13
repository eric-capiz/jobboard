// cloud-run/server/server.mjs
import http from "node:http";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// api/state.ts
import { MongoClient } from "mongodb";
var client = null;
async function getCollection() {
  if (!client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI not set");
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db("dealboard").collection("app_state");
}
function authorized(req) {
  const key = req.headers["x-sync-key"];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}
async function handler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const col = await getCollection();
    if (req.method === "GET") {
      const doc = await col.findOne({ _id: "jobboard" });
      if (!doc) return res.status(404).json({ error: "empty" });
      return res.status(200).json({ state: doc.state, updatedAt: doc.updatedAt });
    }
    if (req.method === "PUT") {
      const { state } = req.body ?? {};
      if (!state || typeof state !== "object") {
        return res.status(400).json({ error: "state required" });
      }
      await col.updateOne(
        { _id: "jobboard" },
        { $set: { state, updatedAt: /* @__PURE__ */ new Date() } },
        { upsert: true }
      );
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return res.status(500).json({ error: msg });
  }
}

// api/finder-lib.ts
import { MongoClient as MongoClient2 } from "mongodb";
function authorized2(req) {
  const key = req.headers["x-sync-key"];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}
function firstQuery(req, name) {
  const v = req.query?.[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
var SUFFIXES = [
  " corporation",
  " incorporated",
  " company",
  " corp",
  " inc",
  " llc",
  " llp",
  " ltd",
  " lp",
  " co"
];
function nameKey(name) {
  let n = name.toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const suf of SUFFIXES) {
    if (n.endsWith(suf)) {
      n = n.slice(0, -suf.length).trim();
      break;
    }
  }
  return n;
}
function domainOf(website) {
  try {
    const host = new URL(website).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return website.toLowerCase().trim();
  }
}
var AGGREGATOR_HOSTS = /* @__PURE__ */ new Set([
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "monster.com",
  "simplyhired.com",
  "careerbuilder.com",
  "dice.com",
  "jobleads.com",
  "seoclerk.com",
  "macslist.org",
  "snagajob.com",
  "careerjet.com",
  "jooble.org",
  "flexjobs.com"
]);
function isAggregatorUrl(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const d of AGGREGATOR_HOSTS) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}
function isBoardUrl(url) {
  return /greenhouse\.io|lever\.co|ashbyhq\.com|jazz\.co|applytojob\.com/i.test(url) || isAggregatorUrl(url);
}
function toCompanyDoc(input) {
  const name = (input.name ?? "").trim();
  if (!name) return null;
  const website = (input.website ?? "").trim();
  const domain = website ? domainOf(website) : "";
  const doc = {
    name,
    website,
    nameKey: nameKey(name),
    careersUrl: (input.careersUrl ?? "").trim(),
    category: (input.category ?? "").trim(),
    source: (input.source ?? "").trim(),
    addedAt: input.addedAt ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  if (domain) doc.domain = domain;
  const sourceId = (input.sourceId ?? "").trim();
  if (sourceId) doc.sourceId = sourceId;
  return doc;
}
function toRow(doc) {
  return {
    id: String(doc._id ?? ""),
    name: doc.name,
    website: doc.website,
    careersUrl: doc.careersUrl,
    category: doc.category,
    source: doc.source,
    addedAt: doc.addedAt
  };
}
var mongoClient = null;
var indexesReady = false;
async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  if (!mongoClient) {
    mongoClient = new MongoClient2(uri);
    await mongoClient.connect();
  }
  return mongoClient.db("dealboard");
}
async function getCompaniesCollection() {
  const db = await getDb();
  const col = db.collection("companies");
  if (!indexesReady) {
    try {
      await col.createIndex({ domain: 1, nameKey: 1 }, { unique: true, sparse: true });
      await col.createIndex({ domain: 1 });
      await col.createIndex({ nameKey: 1 });
      await col.createIndex({ addedAt: 1 });
    } catch {
    }
    indexesReady = true;
  }
  return col;
}
async function resolveIsUSCompany(companiesCol, input) {
  const ors = [];
  const nk = nameKey(input.name ?? "");
  if (nk) ors.push({ nameKey: nk });
  for (const site of [input.website, input.careersUrl]) {
    if (!site) continue;
    const d = domainOf(site);
    if (!d) continue;
    ors.push({ domain: d });
    const parts = d.split(".");
    if (parts.length >= 3) ors.push({ domain: parts.slice(1).join(".") });
  }
  if (ors.length === 0) return false;
  const doc = await companiesCol.findOne({ $or: ors });
  if (!doc) return false;
  return (doc.source ?? "") !== "Manual";
}
async function getAppStateCollection() {
  const db = await getDb();
  return db.collection("app_state");
}
async function findExistingPairs(col, docs) {
  const pairs = /* @__PURE__ */ new Set();
  const sourceIds = /* @__PURE__ */ new Set();
  const domains = [...new Set(docs.map((d) => d.domain).filter((d) => !!d))];
  const nameKeys = [...new Set(docs.map((d) => d.nameKey).filter(Boolean))];
  const qids = [...new Set(docs.map((d) => d.sourceId).filter((s) => !!s))];
  if (domains.length === 0 && nameKeys.length === 0 && qids.length === 0) {
    return { pairs, sourceIds };
  }
  const or = [];
  if (domains.length > 0) or.push({ domain: { $in: domains } });
  if (nameKeys.length > 0) or.push({ nameKey: { $in: nameKeys } });
  if (qids.length > 0) or.push({ sourceId: { $in: qids } });
  const found = await col.find({ $or: or }).project({ domain: 1, nameKey: 1, sourceId: 1 }).toArray();
  for (const f of found) {
    pairs.add(`${f.nameKey ?? ""}|${f.domain ?? ""}`);
    if (f.sourceId) sourceIds.add(f.sourceId);
  }
  return { pairs, sourceIds };
}
function splitNew(docs, existing) {
  const fresh = [];
  const skippedDocs = [];
  let skipped = 0;
  for (const d of docs) {
    const key = `${d.nameKey}|${d.domain ?? ""}`;
    if (existing.pairs.has(key) || d.sourceId && existing.sourceIds.has(d.sourceId)) {
      skipped += 1;
      skippedDocs.push(d);
      continue;
    }
    existing.pairs.add(key);
    if (d.sourceId) existing.sourceIds.add(d.sourceId);
    fresh.push(d);
  }
  return { fresh, skipped, skippedDocs };
}
var SOCIAL_HOSTS = /* @__PURE__ */ new Set([
  "facebook.com",
  "www.facebook.com",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
  "youtube.com",
  "www.youtube.com",
  "tiktok.com",
  "www.tiktok.com"
]);
function isSocialUrl(site) {
  if (!site) return false;
  try {
    return SOCIAL_HOSTS.has(new URL(site).hostname.toLowerCase());
  } catch {
    return false;
  }
}
async function upgradeWebsite(col, doc) {
  if (!doc.sourceId || !doc.website || isSocialUrl(doc.website)) return 0;
  const existing = await col.findOne({ sourceId: doc.sourceId });
  if (!existing || !isSocialUrl(existing.website)) return 0;
  const clash = await col.findOne({
    domain: doc.domain,
    nameKey: existing.nameKey
  });
  if (clash && String(clash._id) !== String(existing._id)) {
    return 0;
  }
  try {
    await col.updateOne(
      { _id: existing._id },
      { $set: { website: doc.website, domain: doc.domain } }
    );
  } catch (e) {
    if (e?.code === 11e3) return 0;
    throw e;
  }
  return 1;
}
async function insertCompanies(col, docs) {
  if (docs.length === 0) return 0;
  try {
    const r = await col.insertMany(docs, { ordered: false });
    return r.insertedCount;
  } catch (e) {
    const err = e;
    const nonDup = (err.writeErrors ?? []).filter((we) => we?.code !== 11e3);
    if (nonDup.length > 0) throw e;
    const inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
    return typeof inserted === "number" ? inserted : 0;
  }
}
async function addCompanies(col, inputs) {
  const docs = [];
  let invalid = 0;
  for (const input of inputs) {
    const doc = toCompanyDoc(input);
    if (!doc) invalid += 1;
    else docs.push(doc);
  }
  const existing = await findExistingPairs(col, docs);
  const { fresh, skipped } = splitNew(docs, existing);
  const inserted = await insertCompanies(col, fresh);
  return { inserted, skipped: skipped + (fresh.length - inserted), invalid };
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function listCompanies(col, opts) {
  const skip = Number.isFinite(opts.skip) && opts.skip >= 0 ? Math.floor(opts.skip) : 0;
  const limit = Number.isFinite(opts.limit) ? Math.min(100, Math.max(1, Math.floor(opts.limit))) : 25;
  const filter = {};
  const q = (opts.q ?? "").trim();
  if (q) {
    const rx = { $regex: escapeRegExp(q), $options: "i" };
    filter.$or = [{ name: rx }, { website: rx }, { category: rx }];
  }
  const total = await col.countDocuments(filter);
  const docs = await col.find(filter).sort({ name: 1 }).skip(skip).limit(limit).toArray();
  return { companies: docs.map(toRow), total, skip, limit };
}
async function getFinderCursor(meta) {
  const doc = await meta.findOne({ _id: "find-companies" });
  if (!doc) return { version: 0, sourceIndex: 0, state: {}, pending: [] };
  return {
    version: typeof doc.version === "number" ? doc.version : 0,
    sourceIndex: typeof doc.sourceIndex === "number" ? doc.sourceIndex : 0,
    state: doc.state ?? {},
    pending: Array.isArray(doc.pending) ? doc.pending : []
  };
}
async function saveFinderCursor(meta, cursor) {
  await meta.updateOne(
    { _id: "find-companies" },
    { $set: { ...cursor, updatedAt: /* @__PURE__ */ new Date() } },
    { upsert: true }
  );
}
async function migrateStateCompanies(companiesCol, appStateCol) {
  const doc = await appStateCol.findOne({ _id: "jobboard" });
  const list = doc?.state?.companies;
  if (!Array.isArray(list) || list.length === 0) {
    return { moved: 0, skipped: 0, invalid: 0, cleared: false };
  }
  const inputs = list.map((c) => {
    const o = typeof c === "object" && c !== null ? c : {};
    return {
      name: String(o.name ?? ""),
      website: String(o.website ?? ""),
      careersUrl: String(o.careersUrl ?? ""),
      category: String(o.category ?? ""),
      source: String(o.source ?? ""),
      addedAt: typeof o.addedAt === "string" ? o.addedAt : void 0
    };
  });
  const result = await addCompanies(companiesCol, inputs);
  const cleared = result.invalid === 0;
  if (cleared) {
    await appStateCol.updateOne(
      { _id: "jobboard" },
      { $set: { "state.companies": [] } }
    );
  }
  return { moved: result.inserted, skipped: result.skipped, invalid: result.invalid, cleared };
}

// api/companies.ts
async function handler2(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!authorized2(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const col = await getCompaniesCollection();
    const skipRaw = Number(firstQuery(req, "skip") ?? 0);
    const limitRaw = Number(firstQuery(req, "limit") ?? 25);
    const result = await listCompanies(col, {
      skip: Number.isFinite(skipRaw) ? skipRaw : 0,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
      q: firstQuery(req, "q") ?? ""
    });
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// api/companies/import.ts
var MAX_ROWS = 5e3;
async function handler3(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!authorized2(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const body = req.body ?? {};
    const rows = Array.isArray(body.companies) ? body.companies : [];
    const inputs = rows.slice(0, MAX_ROWS).map((c) => {
      const o = typeof c === "object" && c !== null ? c : {};
      return {
        name: String(o.name ?? ""),
        website: String(o.website ?? ""),
        careersUrl: String(o.careersUrl ?? ""),
        category: String(o.category ?? ""),
        source: String(o.source ?? ""),
        addedAt: typeof o.addedAt === "string" ? o.addedAt : void 0
      };
    });
    const col = await getCompaniesCollection();
    const result = await addCompanies(col, inputs);
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// api/companies/migrate.ts
async function handler4(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!authorized2(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const db = await getDb();
    const col = await getCompaniesCollection();
    const appStateCol = db.collection("app_state");
    const result = await migrateStateCompanies(col, appStateCol);
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// api/find-companies.ts
var SOURCES_VERSION = 2;
var FUNCTION_BUDGET_MS = 55e3;
var WDQS_TIMEOUT_MS = 45e3;
var WDQS_PAGE_ROWS = 300;
var MAX_BATCH = 2e3;
function websiteScore(site) {
  try {
    const u = new URL(site);
    const path2 = u.pathname;
    return (path2 !== "/" && path2 !== "" ? 1 : 0) + (!u.hostname.endsWith(".com") ? 1 : 0) + (isSocialUrl(site) ? 2 : 0) + site.length / 1e4;
  } catch {
    return 99;
  }
}
var WDQS_TYPE_IDS = ["Q4830453", "Q783794", "Q891723", "Q6881511"];
var wikidataAdapter = {
  key: "wikidata",
  label: "Wikidata",
  async fetchPage(state, budgetMs, fetchFn) {
    const typeIndex = typeof state.typeIndex === "number" && state.typeIndex >= 0 && state.typeIndex < WDQS_TYPE_IDS.length ? state.typeIndex : 0;
    const offsets = (Array.isArray(state.offsets) ? state.offsets : []).map(
      (o) => typeof o === "number" && o >= 0 ? o : 0
    );
    while (offsets.length < WDQS_TYPE_IDS.length) offsets.push(0);
    const offset = offsets[typeIndex];
    const type = WDQS_TYPE_IDS[typeIndex];
    const query = `SELECT ?company ?companyLabel ?website WHERE { ?company wdt:P31 wd:${type} . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } . ?company wdt:P856 ?website . SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } LIMIT ${WDQS_PAGE_ROWS} OFFSET ${offset}`;
    const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString();
    const r = await fetchFn(url, {
      headers: { "User-Agent": "JobBoardFinder/1.0 (job search research)" },
      signal: AbortSignal.timeout(budgetMs)
    });
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings = data?.results?.bindings ?? [];
    const byEnt = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      const uri = b.company?.value ?? "";
      const ent = uri.split("/").pop() ?? uri;
      const name = b.companyLabel?.value ?? ent;
      const site = b.website?.value ?? "";
      if (!site) continue;
      const cur = byEnt.get(ent);
      if (!cur || websiteScore(site) < websiteScore(cur.website)) {
        byEnt.set(ent, { name, website: site });
      }
    }
    const nextOffsets = [...offsets];
    nextOffsets[typeIndex] = offset + WDQS_PAGE_ROWS;
    const typeExhausted = bindings.length < WDQS_PAGE_ROWS;
    const nextTypeIndex = typeExhausted ? typeIndex + 1 : typeIndex;
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: "",
        category: "General",
        source: "Wikidata",
        sourceId: qid
      })),
      nextState: { typeIndex: nextTypeIndex, offsets: nextOffsets },
      exhausted: nextTypeIndex >= WDQS_TYPE_IDS.length
    };
  }
};
var SOCIAL_PROPS = [
  { key: "fb", prop: "P2013", base: "https://www.facebook.com/" },
  { key: "x", prop: "P2002", base: "https://x.com/" },
  { key: "ig", prop: "P2003", base: "https://www.instagram.com/" },
  { key: "li", prop: "P4264", base: "https://www.linkedin.com/company/" },
  { key: "yt", prop: "P2397", base: "https://www.youtube.com/channel/" },
  { key: "tt", prop: "P7085", base: "https://www.tiktok.com/@" }
];
var SOCIAL_COMBOS = [];
for (const prop of SOCIAL_PROPS) {
  for (const type of WDQS_TYPE_IDS) SOCIAL_COMBOS.push({ prop, type });
}
var wikidataSocialAdapter = {
  key: "wikidata-social",
  label: "Wikidata social",
  async fetchPage(state, budgetMs, fetchFn) {
    const comboIndex = typeof state.comboIndex === "number" && state.comboIndex >= 0 ? state.comboIndex : 0;
    const offsets = Array.isArray(state.offsets) ? state.offsets : [];
    const offset = offsets[comboIndex] ?? 0;
    const combo = SOCIAL_COMBOS[comboIndex];
    if (!combo) return { companies: [], nextState: { comboIndex, offsets }, exhausted: true };
    const query = `SELECT ?company ?companyLabel ?website WHERE { ?company wdt:P31 wd:${combo.type} . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } ?company wdt:${combo.prop.prop} ?sid . BIND(IRI(CONCAT('${combo.prop.base}', ENCODE_FOR_URI(STR(?sid)))) AS ?website) SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } LIMIT ${WDQS_PAGE_ROWS} OFFSET ${offset}`;
    const r = await fetchFn(
      "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: {
          "User-Agent": "JobBoardFinder/1.0 (job search research)",
          Accept: "application/sparql-results+json"
        },
        signal: AbortSignal.timeout(budgetMs)
      }
    );
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings = data?.results?.bindings ?? [];
    const byEnt = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      const ent = b.company?.value?.split("/").pop() ?? "";
      if (!ent) continue;
      const name = b.companyLabel?.value ?? ent;
      const site = b.website?.value ?? "";
      if (!site) continue;
      const cur = byEnt.get(ent);
      if (!cur || websiteScore(site) < websiteScore(cur.website)) {
        byEnt.set(ent, { name, website: site });
      }
    }
    const nextOffsets = [...offsets];
    nextOffsets[comboIndex] = offset + WDQS_PAGE_ROWS;
    const comboExhausted = bindings.length < WDQS_PAGE_ROWS;
    const nextComboIndex = comboExhausted ? comboIndex + 1 : comboIndex;
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: "",
        category: "General",
        source: "Wikidata",
        sourceId: qid
      })),
      nextState: { comboIndex: nextComboIndex, offsets: nextOffsets },
      exhausted: nextComboIndex >= SOCIAL_COMBOS.length
    };
  }
};
var SEC_USER_AGENT = "JobBoardFinder/1.0 (job search research; ericcapiz@gmail.com)";
var US_STATE_CODES = /* @__PURE__ */ new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC"
]);
var EDGAR_WAVE_SIZE = 25;
var EDGAR_CONCURRENCY = 5;
var EDGAR_FETCH_TIMEOUT_MS = 15e3;
var EDGAR_TICKER_CACHE_MS = 6e4;
var tickerMapCache = null;
async function fetchTickerMap(fetchFn, nowMs, budgetMs) {
  if (tickerMapCache && nowMs - tickerMapCache.at < EDGAR_TICKER_CACHE_MS) {
    return tickerMapCache.entries;
  }
  const r = await fetchFn("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_USER_AGENT },
    signal: AbortSignal.timeout(Math.min(15e3, budgetMs))
  });
  if (!r.ok) throw new Error(`SEC ticker map HTTP ${r.status}`);
  const data = await r.json();
  const values = Array.isArray(data) ? data : Object.values(data);
  const entries = [];
  for (const v of values) {
    const o = v;
    const cik = Number(o.cik_str);
    if (!Number.isFinite(cik) || cik <= 0) continue;
    entries.push({
      cik: Math.floor(cik),
      ticker: String(o.ticker ?? ""),
      title: String(o.title ?? "")
    });
  }
  entries.sort((a, b) => a.cik - b.cik);
  tickerMapCache = { at: nowMs, entries };
  return entries;
}
var edgarAdapter = {
  key: "edgar",
  label: "SEC EDGAR",
  async fetchPage(state, budgetMs, fetchFn) {
    const tickerIndex = typeof state.tickerIndex === "number" && state.tickerIndex >= 0 ? state.tickerIndex : 0;
    const startedAt = Date.now();
    const entries = await fetchTickerMap(fetchFn, startedAt, budgetMs);
    const wave = entries.slice(tickerIndex, tickerIndex + EDGAR_WAVE_SIZE);
    if (wave.length === 0) {
      return { companies: [], nextState: { tickerIndex }, exhausted: true };
    }
    const companies = [];
    let claimed = 0;
    async function worker() {
      while (claimed < wave.length) {
        const remaining = budgetMs - (Date.now() - startedAt);
        if (remaining < 3e3) return;
        const entry = wave[claimed];
        claimed += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const cikPad = String(entry.cik).padStart(10, "0");
          const fetchRemaining = budgetMs - (Date.now() - startedAt);
          const r = await fetchFn(`https://data.sec.gov/submissions/CIK${cikPad}.json`, {
            headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(
              Math.min(EDGAR_FETCH_TIMEOUT_MS, Math.max(3e3, fetchRemaining))
            )
          });
          if (!r.ok) continue;
          const data = await r.json();
          const website = String(data.website ?? "").trim();
          if (!website) continue;
          const incorp = String(data.stateOfIncorporation ?? "").toUpperCase();
          const addresses = data.addresses;
          const bizState = String(addresses?.business?.stateOrCountry ?? "").toUpperCase();
          if (!US_STATE_CODES.has(incorp) && !US_STATE_CODES.has(bizState)) continue;
          const name = String(data.name ?? "").trim() || entry.title;
          if (!name) continue;
          companies.push({
            name,
            website,
            careersUrl: "",
            category: "Public company",
            source: "SEC EDGAR",
            sourceId: `CIK${cikPad}`
          });
        } catch {
          continue;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(EDGAR_CONCURRENCY, wave.length) }, () => worker())
    );
    return {
      companies,
      nextState: { tickerIndex: tickerIndex + claimed },
      exhausted: tickerIndex + claimed >= entries.length
    };
  }
};
var wikidataSocialOrgAdapter = {
  key: "wikidata-social-organization",
  label: "Wikidata social organization",
  async fetchPage(state, budgetMs, fetchFn) {
    const combos = SOCIAL_PROPS.map((prop) => ({ prop, type: "Q43229" }));
    const comboIndex = typeof state.comboIndex === "number" && state.comboIndex >= 0 ? state.comboIndex : 0;
    const offsets = Array.isArray(state.offsets) ? state.offsets : [];
    const offset = offsets[comboIndex] ?? 0;
    const combo = combos[comboIndex];
    if (!combo) return { companies: [], nextState: { comboIndex, offsets }, exhausted: true };
    const query = `SELECT ?company ?companyLabel ?website WHERE { ?company wdt:P31 wd:${combo.type} . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } ?company wdt:${combo.prop.prop} ?sid . BIND(IRI(CONCAT('${combo.prop.base}', ENCODE_FOR_URI(STR(?sid)))) AS ?website) SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } LIMIT ${WDQS_PAGE_ROWS} OFFSET ${offset}`;
    const r = await fetchFn(
      "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: {
          "User-Agent": "JobBoardFinder/1.0 (job search research)",
          Accept: "application/sparql-results+json"
        },
        signal: AbortSignal.timeout(budgetMs)
      }
    );
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings = data?.results?.bindings ?? [];
    const byEnt = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      const ent = b.company?.value?.split("/").pop() ?? "";
      if (!ent) continue;
      const name = b.companyLabel?.value ?? ent;
      const site = b.website?.value ?? "";
      if (!site) continue;
      const cur = byEnt.get(ent);
      if (!cur || websiteScore(site) < websiteScore(cur.website)) {
        byEnt.set(ent, { name, website: site });
      }
    }
    const nextOffsets = [...offsets];
    nextOffsets[comboIndex] = offset + WDQS_PAGE_ROWS;
    const comboExhausted = bindings.length < WDQS_PAGE_ROWS;
    const nextComboIndex = comboExhausted ? comboIndex + 1 : comboIndex;
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: "",
        category: "General",
        source: "Wikidata",
        sourceId: qid
      })),
      nextState: { comboIndex: nextComboIndex, offsets: nextOffsets },
      exhausted: nextComboIndex >= combos.length
    };
  }
};
var wikidataOrgAdapter = {
  key: "wikidata-organization",
  label: "Wikidata organization",
  async fetchPage(state, budgetMs, fetchFn) {
    const offset = typeof state.offset === "number" && state.offset >= 0 ? state.offset : 0;
    const query = `SELECT ?company ?companyLabel ?website WHERE { ?company wdt:P31 wd:Q43229 . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } . ?company wdt:P856 ?website . SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } LIMIT ${WDQS_PAGE_ROWS} OFFSET ${offset}`;
    const r = await fetchFn(
      "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: { "User-Agent": "JobBoardFinder/1.0 (job search research)" },
        signal: AbortSignal.timeout(budgetMs)
      }
    );
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings = data?.results?.bindings ?? [];
    const byEnt = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      const uri = b.company?.value ?? "";
      const ent = uri.split("/").pop() ?? uri;
      const name = b.companyLabel?.value ?? ent;
      const site = b.website?.value ?? "";
      if (!site) continue;
      const cur = byEnt.get(ent);
      if (!cur || websiteScore(site) < websiteScore(cur.website)) {
        byEnt.set(ent, { name, website: site });
      }
    }
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: "",
        category: "General",
        source: "Wikidata",
        sourceId: qid
      })),
      nextState: { offset: offset + WDQS_PAGE_ROWS },
      exhausted: bindings.length < WDQS_PAGE_ROWS
    };
  }
};
var wikidataOrgKeysetAdapter = {
  key: "wikidata-organization-keyset",
  label: "Wikidata organization keyset",
  neverSkip: true,
  async fetchPage(state, budgetMs, fetchFn) {
    const lastIri = typeof state.lastIri === "string" && state.lastIri ? state.lastIri : "";
    const query = "SELECT ?company ?companyLabel ?website WHERE { ?company wdt:P31 wd:Q43229 . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } . ?company wdt:P856 ?website . " + (lastIri ? `FILTER(STR(?company) > '${lastIri}') ` : "") + `SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } } ORDER BY STR(?company) LIMIT ${WDQS_PAGE_ROWS}`;
    const r = await fetchFn(
      "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: { "User-Agent": "JobBoardFinder/1.0 (job search research)" },
        signal: AbortSignal.timeout(budgetMs)
      }
    );
    if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
    const data = await r.json();
    const bindings = data?.results?.bindings ?? [];
    const byEnt = /* @__PURE__ */ new Map();
    let lastSeen = lastIri;
    for (const b of bindings) {
      const uri = b.company?.value ?? "";
      if (uri) lastSeen = uri;
      const ent = uri.split("/").pop() ?? uri;
      const name = b.companyLabel?.value ?? ent;
      const site = b.website?.value ?? "";
      if (!site) continue;
      const cur = byEnt.get(ent);
      if (!cur || websiteScore(site) < websiteScore(cur.website)) {
        byEnt.set(ent, { name, website: site });
      }
    }
    return {
      companies: [...byEnt.entries()].map(([qid, c]) => ({
        name: c.name,
        website: c.website,
        careersUrl: "",
        category: "General",
        source: "Wikidata",
        sourceId: qid
      })),
      nextState: { lastIri: lastSeen },
      exhausted: bindings.length < WDQS_PAGE_ROWS
    };
  }
};
var WDQS_TYPE_KEYSET_IDS = [
  "Q3918",
  "Q3914",
  "Q16917",
  "Q27686",
  "Q11707",
  "Q33506",
  "Q189004",
  "Q7075",
  "Q24354",
  // Batch 2 (2026-11-03, all first pages 1-4s): bank, airline,
  // insurance company, retailer, manufacturer, sports club,
  // government agency, nonprofit organization. APPEND ONLY — the
  // live cursor indexes into this list, so inserting or reordering
  // would send the walk to the wrong type.
  "Q22687",
  "Q46970",
  "Q2143354",
  "Q99536263",
  "Q13235160",
  "Q847017",
  "Q327333",
  "Q163740"
];
async function wdqsJson(query, budgetMs, fetchFn) {
  const r = await fetchFn(
    "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" }).toString(),
    {
      headers: { "User-Agent": "JobBoardFinder/1.0 (job search research)" },
      signal: AbortSignal.timeout(Math.max(1e3, budgetMs))
    }
  );
  if (!r.ok) throw new Error(`WDQS HTTP ${r.status}`);
  const data = await r.json();
  return data?.results?.bindings ?? [];
}
function keysetTypesAdapter(key, label, typeIds) {
  return {
    key,
    label,
    neverSkip: true,
    async fetchPage(state, budgetMs, fetchFn) {
      const startedAt = Date.now();
      const types = typeIds;
      let typeIndex = typeof state.typeIndex === "number" && state.typeIndex >= 0 && state.typeIndex <= types.length ? state.typeIndex : 0;
      let lastIri = typeof state.lastIri === "string" && state.lastIri ? state.lastIri : "";
      let failures = typeof state.failures === "number" && state.failures >= 0 ? state.failures : 0;
      let skipped = Array.isArray(state.skipped) ? state.skipped.filter(
        (n) => typeof n === "number" && n >= 0 && n < types.length
      ) : [];
      let round = state.round === 1 ? 1 : 0;
      if (typeIndex >= types.length) {
        if (skipped.length > 0 && round === 0) {
          round = 1;
          typeIndex = skipped[0];
          skipped = [];
          lastIri = "";
          failures = 0;
        } else {
          return {
            companies: [],
            nextState: { typeIndex, lastIri: "", failures: 0, skipped, round },
            exhausted: true
          };
        }
      }
      const typeId = types[typeIndex];
      const pageQuery = `SELECT ?company ?website WHERE { ?company wdt:P31 wd:${typeId} . { ?company wdt:P17 wd:Q30 . } UNION { ?company wdt:P159 ?hq . ?hq wdt:P17 wd:Q30 . } . ?company wdt:P856 ?website . ` + (lastIri ? `FILTER(STR(?company) > '${lastIri}') ` : "") + `} ORDER BY STR(?company) LIMIT ${WDQS_PAGE_ROWS}`;
      let bindings;
      try {
        bindings = await wdqsJson(pageQuery, budgetMs, fetchFn);
      } catch {
        failures += 1;
        if (failures >= 3) {
          if (!skipped.includes(typeIndex)) skipped.push(typeIndex);
          return {
            companies: [],
            nextState: {
              typeIndex: typeIndex + 1,
              lastIri: "",
              failures: 0,
              skipped,
              round
            },
            exhausted: false
          };
        }
        return {
          companies: [],
          nextState: { typeIndex, lastIri, failures, skipped, round },
          exhausted: false
        };
      }
      const byEnt = /* @__PURE__ */ new Map();
      let lastSeen = lastIri;
      for (const b of bindings) {
        const uri = b.company?.value ?? "";
        if (uri) lastSeen = uri;
        const ent = uri.split("/").pop() ?? uri;
        const site = b.website?.value ?? "";
        if (!site) continue;
        const cur = byEnt.get(ent);
        if (!cur || websiteScore(site) < websiteScore(cur.website)) {
          byEnt.set(ent, { name: ent, website: site });
        }
      }
      const iris = [...byEnt.keys()];
      const labels = /* @__PURE__ */ new Map();
      for (let i = 0; i < iris.length; i += 100) {
        if (Date.now() - startedAt > budgetMs - 8e3) break;
        const chunk = iris.slice(i, i + 100);
        const values = chunk.map((qid) => `<http://www.wikidata.org/entity/${qid}>`).join(" ");
        try {
          const labelBindings = await wdqsJson(
            `SELECT ?company ?companyLabel WHERE { VALUES ?company { ${values} } SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } }`,
            1e4,
            fetchFn
          );
          for (const b of labelBindings) {
            const ent = (b.company?.value ?? "").split("/").pop() ?? "";
            if (ent && b.companyLabel?.value) labels.set(ent, b.companyLabel.value);
          }
        } catch {
        }
      }
      for (const [qid, c] of byEnt) {
        const label2 = labels.get(qid);
        if (label2) c.name = label2;
      }
      const shortPage = bindings.length < WDQS_PAGE_ROWS;
      const nextTypeIndex = shortPage ? typeIndex + 1 : typeIndex;
      const exhausted = nextTypeIndex >= types.length && shortPage && !(skipped.length > 0 && round === 0);
      return {
        companies: [...byEnt.entries()].map(([qid, c]) => ({
          name: c.name,
          website: c.website,
          careersUrl: "",
          category: "General",
          source: "Wikidata",
          sourceId: qid
        })),
        nextState: {
          typeIndex: nextTypeIndex,
          lastIri: shortPage ? "" : lastSeen,
          failures: 0,
          skipped,
          round
        },
        exhausted
      };
    }
  };
}
var wikidataTypesKeysetAdapter = keysetTypesAdapter(
  "wikidata-types-keyset",
  "Wikidata types keyset",
  WDQS_TYPE_KEYSET_IDS
);
var wikidataBusinessKeysetAdapter = keysetTypesAdapter(
  "wikidata-business-keyset",
  "Wikidata business keyset",
  WDQS_TYPE_IDS
);
var SOURCES = [
  wikidataSocialAdapter,
  wikidataAdapter,
  edgarAdapter,
  wikidataSocialOrgAdapter,
  wikidataOrgAdapter,
  wikidataOrgKeysetAdapter,
  wikidataTypesKeysetAdapter,
  wikidataBusinessKeysetAdapter
];
async function runFindCompanies(deps, body) {
  const limitRaw = Number(body.limit ?? MAX_BATCH);
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_BATCH, Math.max(1, Math.floor(limitRaw))) : MAX_BATCH;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let cursor = await getFinderCursor(deps.metaCol);
  if (cursor.version !== SOURCES_VERSION) {
    cursor = { version: SOURCES_VERSION, sourceIndex: 0, state: {}, pending: [] };
    await saveFinderCursor(deps.metaCol, cursor);
  }
  cursor.pending ??= [];
  let added = 0;
  let source = "";
  let transientError = false;
  let advancedPastWork = false;
  let skipNote;
  if (cursor.pending.length > 0 && added < limit) {
    const take = cursor.pending.slice(0, limit - added);
    const drained = await addCompanies(deps.companiesCol, take);
    added += drained.inserted;
    cursor.pending = cursor.pending.slice(take.length);
    advancedPastWork = true;
    await saveFinderCursor(deps.metaCol, cursor);
  }
  while (added < limit && cursor.sourceIndex < SOURCES.length) {
    const remaining = FUNCTION_BUDGET_MS - (now() - startedAt);
    if (remaining < 1e4) break;
    const adapter = SOURCES[cursor.sourceIndex];
    source = adapter.label;
    const subState = cursor.state[adapter.key] ?? {};
    let page;
    try {
      page = await adapter.fetchPage(subState, Math.min(WDQS_TIMEOUT_MS, remaining), deps.fetchFn);
    } catch {
      if (adapter.neverSkip) {
        transientError = true;
        break;
      }
      const failures = (typeof subState.failures === "number" ? subState.failures : 0) + 1;
      if (failures >= 3) {
        cursor.state[adapter.key] = { ...subState, failures: 0 };
        cursor.sourceIndex += 1;
        await saveFinderCursor(deps.metaCol, cursor);
        skipNote = `${adapter.label} is temporarily unavailable and was skipped \u2014 continuing with the next source.`;
        continue;
      }
      cursor.state[adapter.key] = { ...subState, failures };
      await saveFinderCursor(deps.metaCol, cursor);
      transientError = true;
      break;
    }
    const docs = [];
    for (const input of page.companies) {
      const doc = toCompanyDoc(input);
      if (doc) docs.push(doc);
    }
    const existing = await findExistingPairs(deps.companiesCol, docs);
    for (const p of cursor.pending) {
      const d = toCompanyDoc(p);
      if (!d) continue;
      existing.pairs.add(`${d.nameKey}|${d.domain ?? ""}`);
      if (d.sourceId) existing.sourceIds.add(d.sourceId);
    }
    const { fresh, skippedDocs } = splitNew(docs, existing);
    const take = fresh.slice(0, limit - added);
    const rest = fresh.slice(limit - added);
    const inserted = await insertCompanies(deps.companiesCol, take);
    added += inserted;
    for (const d of skippedDocs) {
      await upgradeWebsite(deps.companiesCol, d);
    }
    advancedPastWork = true;
    cursor.pending = [
      ...cursor.pending,
      ...rest.map((d) => ({
        name: d.name,
        website: d.website,
        careersUrl: d.careersUrl,
        category: d.category,
        source: d.source,
        sourceId: d.sourceId
      }))
    ];
    cursor.state[adapter.key] = {
      ...page.nextState,
      failures: typeof page.nextState.failures === "number" ? page.nextState.failures : 0
    };
    if (page.exhausted) cursor.sourceIndex += 1;
    await saveFinderCursor(deps.metaCol, cursor);
  }
  const total = await deps.companiesCol.countDocuments();
  const exhausted = cursor.sourceIndex >= SOURCES.length;
  if (added === 0 && transientError) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      error: "Discovery hit a snag \u2014 press again, nothing was lost."
    };
  }
  if (added === 0 && advancedPastWork) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      note: skipNote ?? "Everything in this stretch was already in your database \u2014 press again to keep going."
    };
  }
  if (added === 0 && !transientError && !advancedPastWork && !exhausted) {
    return {
      added: 0,
      total,
      source,
      exhausted,
      error: "Discovery hit a snag \u2014 press again, nothing was lost."
    };
  }
  return { added, total, source, exhausted, note: skipNote };
}
async function handlerInner(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!authorized2(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const body = req.body ?? {};
  const db = await getDb();
  const result = await runFindCompanies(
    {
      companiesCol: await getCompaniesCollection(),
      metaCol: db.collection("finder_meta"),
      fetchFn: fetch
    },
    { limit: body.limit }
  );
  res.status(200).json(result);
}
async function handler5(req, res) {
  try {
    await handlerInner(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// api/render-page.ts
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

// api/render-search.ts
function scanSearchForm() {
  const forms = Array.from(document.querySelectorAll("form"));
  const formIndexOf = (el) => {
    const f = el.closest("form");
    return f ? forms.indexOf(f) : -1;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      return getComputedStyle(el).visibility !== "hidden";
    } catch {
      return true;
    }
  };
  const topOf = (el) => Math.round(el.getBoundingClientRect().top);
  const inputs = Array.from(document.querySelectorAll("input")).map(
    (el, index) => ({
      index,
      type: (el.getAttribute("type") || "").toLowerCase(),
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      role: el.getAttribute("role") || "",
      cls: el.getAttribute("class") || "",
      title: el.getAttribute("title") || "",
      labelText: (() => {
        try {
          const labels = el.labels;
          return labels ? Array.from(labels).map((l) => l.innerText || "").join(" ") : "";
        } catch {
          return "";
        }
      })(),
      describedBy: (() => {
        try {
          const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
          return ids.map((id) => document.getElementById(id)?.innerText || "").join(" ");
        } catch {
          return "";
        }
      })(),
      formIndex: formIndexOf(el),
      visible: isVisible(el),
      top: topOf(el)
    })
  );
  const buttons = Array.from(
    document.querySelectorAll('button, input[type="submit"], input[type="button"]')
  ).map((el, index) => ({
    index,
    text: (el.innerText || el.getAttribute("value") || "").trim(),
    ariaLabel: el.getAttribute("aria-label") || "",
    title: el.getAttribute("title") || "",
    type: (el.getAttribute("type") || "").toLowerCase(),
    formIndex: formIndexOf(el),
    visible: isVisible(el),
    top: topOf(el)
  }));
  return {
    inputs,
    buttons,
    forms: forms.map((f) => ({
      action: f.getAttribute("action") || "",
      method: (f.getAttribute("method") || "get").toLowerCase()
    }))
  };
}
function countJobListings() {
  const GENERIC = /^(home|about|about us|careers|jobs|job|contact|contact us|login|sign in|join our team|work with us|open positions|current openings|open roles|all roles|see all jobs|view all jobs|view jobs|see jobs|browse jobs|search jobs|browse all jobs|view openings|see openings|view open positions|all jobs|all positions|explore careers|explore jobs|learn more|apply now|view details|view job|see details)$/i;
  let jobLinks = 0;
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const href = a.getAttribute("href") || "";
    const text = (a.innerText || "").trim();
    if (text.length < 3 || GENERIC.test(text)) continue;
    if (!/job|career|position|opening|apply/i.test(href)) continue;
    const r = a.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    jobLinks += 1;
  }
  const bodyText = document.body?.innerText || "";
  let resultsText = false;
  for (const m of bodyText.matchAll(/([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi)) {
    if (parseInt(m[1].replace(/,/g, ""), 10) > 0) {
      resultsText = true;
      break;
    }
  }
  if (!resultsText) {
    for (const m of bodyText.matchAll(/results?\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)/gi)) {
      if (parseInt(m[1].replace(/,/g, ""), 10) > 0) {
        resultsText = true;
        break;
      }
    }
  }
  if (!resultsText) {
    for (const m of bodyText.matchAll(
      /[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi
    )) {
      if (parseInt(m[1].replace(/,/g, ""), 10) > 0) {
        resultsText = true;
        break;
      }
    }
  }
  return { jobLinks, resultsText };
}
function scoreSearchInput(d) {
  if (["hidden", "password", "checkbox", "radio", "file", "submit", "button", "reset"].includes(
    d.type
  )) {
    return -100;
  }
  const signal = `${d.name} ${d.id} ${d.placeholder} ${d.ariaLabel} ${d.role || ""} ${d.cls || ""} ${d.title || ""} ${d.labelText || ""} ${d.describedBy || ""}`.toLowerCase();
  let score = 0;
  if (/location|zip|city|state|postal|radius|distance/.test(signal)) score -= 3;
  if (/keyword/.test(signal)) score += 4;
  if (/\bsearch\b/.test(signal)) score += 2;
  if (/job|title|\bwhat\b|role|position/.test(signal)) score += 2;
  if (/search (field|box|input)|find (jobs|a job)/.test(signal)) score += 2;
  if (d.name === "q" || d.id === "q") score += 2;
  if (d.type === "search") score += 2;
  if (/combobox|searchbox/.test((d.role || "").toLowerCase())) score += 2;
  if (d.formIndex >= 0) score += 1;
  return score;
}
function buttonLabel(b) {
  return `${b.text} ${b.ariaLabel} ${b.title || ""}`;
}
function selectSearchInput(info) {
  let best = null;
  let bestScore = 0;
  for (const d of info.inputs) {
    if (!d.visible) continue;
    const s = scoreSearchInput(d);
    if (s >= 3 && s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  if (!best) return null;
  const sameForm = best.formIndex >= 0 ? info.buttons.filter((b) => b.visible && b.formIndex === best.formIndex) : [];
  const nearest = (list) => {
    let pick;
    let pickDist = Number.POSITIVE_INFINITY;
    for (const b of list) {
      const d = Math.abs(b.top - best.top);
      if (d < pickDist) {
        pick = b;
        pickDist = d;
      }
    }
    return pick;
  };
  const byText = (list) => nearest(list.filter((b) => /search|find/i.test(buttonLabel(b))));
  const button = byText(sameForm) ?? nearest(sameForm.filter((b) => b.type === "submit")) ?? nearest(
    info.buttons.filter(
      (b) => b.visible && /search jobs|find jobs/i.test(buttonLabel(b))
    )
  ) ?? // A bare "Search" button (Walmart, Phenom): the portal's own
  // submit, labelled with nothing more specific.
  nearest(
    info.buttons.filter((b) => b.visible && /\bsearch\b/i.test(buttonLabel(b)))
  ) ?? null;
  const formAction = best.formIndex >= 0 ? info.forms[best.formIndex]?.action ?? "" : "";
  return { input: best, button, formAction };
}
function hasVisibleListings(count) {
  return count.resultsText && count.jobLinks >= 1;
}
function isSearchActionAllowed(action, pageUrl) {
  if (!action) return true;
  try {
    return !isBoardUrl(new URL(action, pageUrl).href);
  } catch {
    return false;
  }
}
function isSiteSearchAction(action, pageUrl) {
  if (!action) return false;
  try {
    const target = new URL(action, pageUrl);
    if (target.href === new URL(pageUrl).href) return false;
    return !/job|career|search|opening|position|role|result|listing/i.test(target.pathname + target.search);
  } catch {
    return false;
  }
}
function summarizeScan(info) {
  let best = null;
  let visibleInputs = 0;
  for (const d of info.inputs) {
    if (!d.visible) continue;
    visibleInputs += 1;
    const s = scoreSearchInput(d);
    if (best === null || s > best) best = s;
  }
  return {
    inputs: info.inputs.length,
    visibleInputs,
    bestScore: best ?? 0,
    buttons: info.buttons.filter((b) => b.visible).length
  };
}
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
async function textLength(page) {
  try {
    const len = await page.evaluate(() => document.body?.innerText?.length ?? 0);
    return typeof len === "number" ? len : -1;
  } catch {
    return -1;
  }
}
async function waitForDomStable(page, remainMs, capMs, intervalMs) {
  const start = Date.now();
  let lastLen = -1;
  let stable = 0;
  while (stable < 2 && Date.now() - start < Math.min(capMs, remainMs())) {
    const len = await textLength(page);
    if (len < 0) break;
    if (len === lastLen) stable += 1;
    else {
      stable = 0;
      lastLen = len;
    }
    if (stable < 2 && remainMs() > 0) await sleep(Math.min(intervalMs, remainMs()));
  }
}
async function listingsNow(page) {
  try {
    return hasVisibleListings(await page.evaluate(countJobListings));
  } catch {
    return false;
  }
}
async function waitForChange(page, remainMs, startUrl, startLen, capMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < Math.min(capMs, Math.max(0, remainMs())) && remainMs() > 0) {
    await sleep(Math.min(400, Math.max(0, remainMs())));
    if (page.url() !== startUrl) return true;
    const len = await textLength(page);
    if (len < 0) return false;
    if (startLen >= 0 && Math.abs(len - startLen) > 200) return true;
  }
  return false;
}
async function submitViaEnter(page, sel, term) {
  let handle = null;
  try {
    handle = await page.evaluateHandle(
      (idx) => document.querySelectorAll("input")[idx],
      sel.input.index
    );
  } catch {
    handle = null;
  }
  const el = handle?.asElement() ?? null;
  if (el) {
    try {
      await el.click();
    } catch {
      try {
        await el.evaluate((node) => node.focus());
      } catch {
      }
    }
    if (term) {
      try {
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
      } catch {
      }
      try {
        await el.type(term, { delay: 20 });
      } catch {
        return false;
      }
    }
  } else {
    try {
      await page.evaluate((idx) => {
        const input = document.querySelectorAll("input")[idx];
        input?.focus();
      }, sel.input.index);
    } catch {
    }
  }
  try {
    await page.keyboard.press("Enter");
    return true;
  } catch {
    return false;
  } finally {
    try {
      await handle?.dispose();
    } catch {
    }
  }
}
async function clickButton(page, buttonIndex) {
  let handle = null;
  try {
    handle = await page.evaluateHandle(
      (idx) => document.querySelectorAll('button, input[type="submit"], input[type="button"]')[idx],
      buttonIndex
    );
  } catch {
    return false;
  }
  const el = handle?.asElement() ?? null;
  if (!el) return false;
  try {
    await el.click();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await handle?.dispose();
    } catch {
    }
  }
}
async function clickSearchToggle(page, remainMs, onToggle) {
  if (remainMs() < 3e3) return null;
  let info;
  try {
    info = await page.evaluate(scanSearchForm);
  } catch {
    return null;
  }
  const allowed = (b) => {
    if (b.formIndex < 0) return true;
    const action = info.forms[b.formIndex]?.action ?? "";
    return isSearchActionAllowed(action, page.url()) && !isSiteSearchAction(action, page.url());
  };
  const label = (b) => buttonLabel(b).trim();
  const pick = info.buttons.find((b) => b.visible && allowed(b) && /search jobs|find jobs|find a job/i.test(label(b))) ?? info.buttons.find((b) => b.visible && allowed(b) && /\bsearch\b/i.test(label(b))) ?? null;
  if (!pick) return null;
  const startUrl = page.url();
  const startLen = await textLength(page);
  if (!await clickButton(page, pick.index)) return null;
  onToggle?.(label(pick));
  await waitForChange(page, remainMs, startUrl, startLen, 4e3);
  if (isBoardUrl(page.url())) return "board";
  return "toggled";
}
function scanGateControls() {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      return getComputedStyle(el).visibility !== "hidden";
    } catch {
      return true;
    }
  };
  const containerOf = (el) => {
    let role = "";
    let cls = false;
    let node = el.parentElement;
    while (node) {
      if (!role) {
        const r = (node.getAttribute?.("role") || "").toLowerCase();
        if (["listbox", "menu", "dialog", "tablist", "combobox"].includes(r)) role = r;
      }
      if (!cls) {
        const c = `${node.getAttribute?.("class") || ""} ${node.getAttribute?.("id") || ""}`;
        if (/picker|modal|menu|dropdown|listbox|dialog|popover|popup|drawer|overlay/i.test(c)) cls = true;
      }
      if (role && cls) break;
      node = node.parentElement;
    }
    return { role, cls };
  };
  const selectLabel = (el) => {
    try {
      const labels = el.labels;
      if (labels && labels.length) {
        return Array.from(labels).map((l) => l.innerText || "").join(" ");
      }
    } catch {
    }
    return el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("id") || el.getAttribute("title") || "";
  };
  const controls = [];
  const btns = Array.from(
    document.querySelectorAll('button, a, [role="tab"], [role="option"], [role="menuitem"], [role="button"]')
  );
  btns.forEach((el, index) => {
    const cont = containerOf(el);
    controls.push({
      kind: "button",
      index,
      label: (el.innerText || "").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      href: el.getAttribute("href") || "",
      containerRole: cont.role,
      containerClass: cont.cls,
      role: (el.getAttribute("role") || el.tagName.toLowerCase()).toLowerCase(),
      visible: isVisible(el),
      options: []
    });
  });
  const selects = Array.from(document.querySelectorAll("select"));
  selects.forEach((el, index) => {
    const cont = containerOf(el);
    controls.push({
      kind: "select",
      index,
      label: selectLabel(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      href: "",
      containerRole: cont.role,
      containerClass: cont.cls,
      role: "select",
      visible: isVisible(el),
      options: Array.from(el.options).map((o, oi) => ({
        index: oi,
        text: (o.text || "").trim(),
        value: o.value || "",
        selected: o.selected
      }))
    });
  });
  return { controls };
}
function gateButtonElement(idx) {
  return document.querySelectorAll('button, a, [role="tab"], [role="option"], [role="menuitem"], [role="button"]')[idx] ?? null;
}
function pickSelectOption(selectIndex, optionIndex) {
  const sel = document.querySelectorAll("select")[selectIndex];
  const opt = sel?.options[optionIndex];
  if (!sel || !opt) return false;
  try {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    )?.set;
    if (setter) setter.call(sel, opt.value);
    else sel.value = opt.value;
  } catch {
    sel.value = opt.value;
  }
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return sel.value === opt.value;
}
function normalizeGateLabel(text) {
  return text.replace(/\s+/g, " ").trim().replace(/\s*\(.*?\)\s*$/, "").replace(/\s*[-–—|,].*$/, "").trim();
}
var ROLE_NOUNS = /representative|manager|associate|specialist|agent|engineer|analyst|coordinator|lead|director|supervisor|technician|consultant|officer/i;
function gateTargetOf(normalized, searchTerm) {
  if (/^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i.test(normalized)) return "us";
  if (/^english$/i.test(normalized)) return "english";
  if (/^(remote|work[- ]from[- ]home|wfh)$/i.test(normalized)) return "remote";
  if (searchTerm) {
    const words = searchTerm.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (words.length > 0 && wordCount <= 4 && !/\d/.test(normalized) && !ROLE_NOUNS.test(normalized)) {
      const lower = normalized.toLowerCase();
      const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (words.every((w) => new RegExp(`\\b${esc(w)}\\b`).test(lower))) return "role";
    }
  }
  return null;
}
var GATE_TARGET_PRIORITY = { us: 0, english: 1, remote: 2, role: 3 };
function selectGateAction(scan, searchTerm, gateOpened, pageUrl, excludeLabels = [], excludeTargets = []) {
  const excluded = (rawLabel) => excludeLabels.some((x) => normalizeGateLabel(x) === normalizeGateLabel(rawLabel));
  let bestPick = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  const consider = (action) => {
    const p = GATE_TARGET_PRIORITY[action.target];
    if (p < bestPriority) {
      bestPick = action;
      bestPriority = p;
    }
  };
  for (const c of scan.controls) {
    if (!c.visible) continue;
    if (c.kind === "select") {
      if (c.options.length < 2) continue;
      for (const opt of c.options) {
        if (opt.selected || !opt.text.trim()) continue;
        const target2 = gateTargetOf(normalizeGateLabel(opt.text), searchTerm);
        if (target2) {
          consider({ kind: "select", index: c.index, optionIndex: opt.index, label: opt.text.trim(), target: target2 });
        }
      }
      continue;
    }
    const raw = (c.label || c.ariaLabel || "").trim();
    if (!raw) continue;
    const normalized = normalizeGateLabel(raw);
    if (!normalized) continue;
    if (excluded(raw)) continue;
    const inPicker = c.containerRole !== "" || c.containerClass || c.role === "tab" || c.role === "option" || c.role === "menuitem";
    const target = gateTargetOf(normalized, searchTerm);
    if (!target) continue;
    if (excludeTargets.includes(target)) continue;
    if (target === "role" && !inPicker) continue;
    const bareLocale = !inPicker && (target === "us" || target === "english");
    if (!inPicker && !gateOpened && !bareLocale) continue;
    if (!inPicker && c.href) {
      try {
        const abs = new URL(c.href, pageUrl);
        if (abs.hostname !== new URL(pageUrl).hostname) continue;
        if (isBoardUrl(abs.href)) continue;
      } catch {
        continue;
      }
    }
    consider({ kind: "button", index: c.index, label: raw, target });
  }
  if (bestPick) return bestPick;
  for (const c of scan.controls) {
    if (c.kind !== "button" || !c.visible) continue;
    const text = `${c.label} ${c.ariaLabel}`.trim();
    if (!text) continue;
    if (excluded(text)) continue;
    if (/search jobs|find jobs|find a job/i.test(text) && gateOpened) continue;
    if (/^(meet|our|about|learn|view|explore|read|see|discover|join|contact|get)\b/i.test(text)) continue;
    const openerLabel = normalizeGateLabel(c.label || c.ariaLabel);
    const openerWords = openerLabel.split(/\s+/).filter(Boolean);
    if (openerWords.length > 6) continue;
    if (/^(what|how|why|when|where|which|who|whom|whose|can|could|should|would|will|do|does|did|is|are|was|were|may|might)\b/i.test(openerLabel)) continue;
    if (/\b(country|region|location|language|department|choose your|select your|pick your)\b/i.test(
      text
    )) {
      return { kind: "button", index: c.index, label: (c.label || c.ariaLabel).trim(), target: "open" };
    }
  }
  return null;
}
async function jobLinksNow(page) {
  try {
    return (await page.evaluate(countJobListings)).jobLinks >= 2;
  } catch {
    return false;
  }
}
async function resolveGateOnce(page, remainMs, searchTerm, gateOpened, onCountry, onGate, excludeLabels = [], excludeTargets = []) {
  if (remainMs() < 2500) return null;
  let scan;
  try {
    scan = await page.evaluate(scanGateControls);
  } catch {
    return null;
  }
  const action = selectGateAction(scan, searchTerm, gateOpened, page.url(), excludeLabels, excludeTargets);
  if (!action) return null;
  const startUrl = page.url();
  const startLen = await textLength(page);
  let done = false;
  if (action.kind === "select") {
    try {
      done = await page.evaluate(pickSelectOption, action.index, action.optionIndex ?? 0);
    } catch {
      done = false;
    }
  } else {
    let handle = null;
    try {
      handle = await page.evaluateHandle(gateButtonElement, action.index);
    } catch {
      handle = null;
    }
    const el = handle?.asElement() ?? null;
    if (el) {
      try {
        await el.click();
        done = true;
      } catch {
        done = false;
      } finally {
        try {
          await handle?.dispose();
        } catch {
        }
      }
    }
  }
  if (!done) return null;
  if (action.target === "us") onCountry?.(action.label);
  onGate?.(action.label);
  await waitForChange(page, remainMs, startUrl, startLen, 2500);
  await waitForDomStable(page, remainMs, 2e3, 500);
  if (isBoardUrl(page.url())) return "board";
  if (action.target === "open") return "opened";
  if (page.url() !== startUrl) return "navigated";
  return "picked";
}
async function attemptSearch(page, term, remainMs) {
  let info;
  try {
    info = await page.evaluate(scanSearchForm);
  } catch {
    return "failed";
  }
  const sel = selectSearchInput(info);
  if (!sel) return "no-form";
  if (sel.formAction && !isSearchActionAllowed(sel.formAction, page.url())) return "no-form";
  if (sel.formAction && isSiteSearchAction(sel.formAction, page.url())) return "no-form";
  const startUrl = page.url();
  const startLen = await textLength(page);
  if (!await submitViaEnter(page, sel, term)) return "failed";
  let changed = await waitForChange(page, remainMs, startUrl, startLen, 2500);
  if (!changed && sel.button) {
    const midUrl = page.url();
    const midLen = await textLength(page);
    if (await clickButton(page, sel.button.index)) {
      changed = await waitForChange(page, remainMs, midUrl, midLen, 8e3);
    }
  }
  await waitForDomStable(page, remainMs, 4e3, 500);
  if (isBoardUrl(page.url())) return "board";
  return "settled";
}
async function driveGatesAfterSearch(page, remainMs, searchTerm, onCountry, onGate) {
  let gateOpened = false;
  const drivenLabels = [];
  let droveGate = false;
  let droveCountry = false;
  for (let round = 0; round < 3; round++) {
    const roundUrl = page.url();
    let roundLabel = null;
    const gated = await resolveGateOnce(
      page,
      remainMs,
      searchTerm,
      gateOpened,
      (label) => {
        droveCountry = true;
        onCountry?.(label);
      },
      (label) => {
        roundLabel = label;
        onGate?.(label);
      },
      drivenLabels,
      droveCountry ? ["english"] : []
    );
    if (gated === "board") return "board-redirect";
    if (gated === "navigated") {
      gateOpened = true;
      await waitForDomStable(page, remainMs, 3e3, 500);
      if (await listingsNow(page)) return "searched";
      if (await jobLinksNow(page)) return "searched";
      return "no-form";
    }
    if (gated) {
      droveGate = true;
      if (roundLabel) drivenLabels.push(roundLabel);
      if (page.url() !== roundUrl) gateOpened = false;
      else gateOpened = true;
      await waitForDomStable(page, remainMs, 3e3, 500);
      if (await listingsNow(page)) return "searched";
      if (await jobLinksNow(page)) return "searched";
      continue;
    }
    return droveGate ? "picked" : null;
  }
  await waitForDomStable(page, remainMs, 3e3, 500);
  if (await listingsNow(page)) return "searched";
  if (await jobLinksNow(page)) return "searched";
  return droveGate ? "picked" : null;
}
async function tryPortalSearch(page, searchTerm, deadlineMs, onToggle, onCountry, onGate) {
  const remainMs = () => deadlineMs - Date.now();
  if (remainMs() < 6e3) return "skipped-time";
  if (await listingsNow(page)) return "has-listings";
  const first = await attemptSearch(page, "", remainMs);
  if (first === "board") return "board-redirect";
  if (first === "no-form") {
    const toggled = await clickSearchToggle(page, remainMs, onToggle);
    if (toggled === "board") return "board-redirect";
    let gateOpened = toggled === "toggled";
    let ranSearch = false;
    let droveCountry = false;
    for (let round = 0; round < 4; round++) {
      const roundUrl = page.url();
      const gated2 = await resolveGateOnce(
        page,
        remainMs,
        searchTerm,
        gateOpened,
        (label) => {
          droveCountry = true;
          onCountry?.(label);
        },
        onGate,
        [],
        droveCountry ? ["english"] : []
      );
      if (gated2 === "board") return "board-redirect";
      if (gated2 === "navigated") {
        gateOpened = true;
        await waitForDomStable(page, remainMs, 3e3, 500);
        if (await listingsNow(page)) return "searched";
        if (await jobLinksNow(page)) return "searched";
        return "no-form";
      }
      if (gated2) {
        if (page.url() !== roundUrl) gateOpened = false;
        else gateOpened = true;
        await waitForDomStable(page, remainMs, 3e3, 500);
        if (await listingsNow(page)) return "searched";
        if (await jobLinksNow(page)) return "searched";
        continue;
      }
      const attempt = await attemptSearch(page, "", remainMs);
      if (attempt === "board") return "board-redirect";
      if (attempt === "failed") return "submit-failed";
      if (attempt !== "no-form") {
        ranSearch = true;
        break;
      }
      return "no-form";
    }
    if (!ranSearch) {
      await waitForDomStable(page, remainMs, 3e3, 500);
      if (await listingsNow(page)) return "searched";
      if (await jobLinksNow(page)) return "searched";
      const attempt = await attemptSearch(page, "", remainMs);
      if (attempt === "board") return "board-redirect";
      if (attempt === "failed") return "submit-failed";
      if (attempt === "no-form") return "no-form";
    }
    if (await listingsNow(page)) return "searched";
    if (!searchTerm || remainMs() < 6e3) return "no-results";
    const second = await attemptSearch(page, searchTerm, remainMs);
    if (second === "board") return "board-redirect";
    if (second === "no-form") return "no-form";
    if (second === "failed") return "submit-failed";
    return await listingsNow(page) ? "searched" : "no-results";
  }
  if (first === "failed") return "submit-failed";
  if (await listingsNow(page)) return "searched";
  let tail;
  if (!searchTerm || remainMs() < 6e3) {
    tail = "no-results";
  } else {
    const second = await attemptSearch(page, searchTerm, remainMs);
    if (second === "board") return "board-redirect";
    if (second === "no-form") tail = "no-form";
    else if (second === "failed") return "submit-failed";
    else tail = await listingsNow(page) ? "searched" : "no-results";
  }
  if (tail === "searched") return "searched";
  const gated = await driveGatesAfterSearch(page, remainMs, searchTerm, onCountry, onGate);
  if (gated === "board-redirect") return "board-redirect";
  if (gated === "searched") return "searched";
  if (gated === "no-form") return "no-form";
  if (gated === "picked") {
    if (remainMs() < 6e3) return "no-results";
    const retry = await attemptSearch(page, "", remainMs);
    if (retry === "board") return "board-redirect";
    if (retry === "failed") return "submit-failed";
    if (await listingsNow(page)) return "searched";
    if (!searchTerm || remainMs() < 6e3) return "no-results";
    const retryTerm = await attemptSearch(page, searchTerm, remainMs);
    if (retryTerm === "board") return "board-redirect";
    if (retryTerm === "failed") return "submit-failed";
    return await listingsNow(page) ? "searched" : "no-results";
  }
  return tail;
}

// api/render-page.ts
var CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar";
var RENDER_TIMEOUT_MS = 2e4;
var SETTLE_CAP_MS = 8e3;
var SEARCH_MIN_MS = 9e3;
var RENDER_ABSOLUTE_CAP_MS = 3e4;
function bannerTextPresent(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return /we use cookies|cookie preferences|accept all cookies|consent preferences/i.test(text);
}
function bannerVisibleInPage() {
  const phrases = /we use cookies|cookie preferences|accept (all )?cookies|this site uses cookies|we value your privacy/i;
  const els = Array.from(document.querySelectorAll("body *"));
  for (const el of els) {
    const t = el.innerText || "";
    if (t.length === 0 || t.length > 500 || !phrases.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    try {
      if (getComputedStyle(el).visibility === "hidden") continue;
    } catch {
    }
    return true;
  }
  return false;
}
var browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
      chromium.setGraphicsMode = false;
      return puppeteer.launch({
        args: chromium.args,
        defaultViewport: { width: 800, height: 600 },
        executablePath,
        headless: "shell"
      });
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}
function renderDisabled() {
  return process.env.JOBBOARD_NO_RENDER === "1";
}
function withTimeout(promise, ms) {
  if (ms <= 0) return Promise.resolve(null);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([
    promise.then(
      (value) => {
        clearTimeout(timer);
        return value;
      },
      () => {
        clearTimeout(timer);
        return null;
      }
    ),
    timeout
  ]);
}
async function renderPageHtml(url, searchTerm = "", timeoutMs = RENDER_TIMEOUT_MS) {
  if (renderDisabled()) return null;
  const renderStart = Date.now();
  const deadline = renderStart + timeoutMs;
  const remain = () => deadline - Date.now();
  let browser = null;
  let page = null;
  let cookieClicks = 0;
  let lastAcceptLabels = [];
  let lastClickedLabel = null;
  try {
    browser = await withTimeout(getBrowser(), remain());
    if (!browser || remain() <= 0) {
      return { html: "", searchOutcome: null, searchMs: 0, renderedUrl: "", renderError: "browser-unavailable", cookieClicks };
    }
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "font" || type === "media") void req.abort();
      else void req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1e3, remain()) });
    const tryCookieAccept = async (pg) => {
      try {
        return await pg.evaluate(() => {
          const collectButtons = (root) => {
            const out = Array.from(root.querySelectorAll('button, a, [role="button"]'));
            root.querySelectorAll("*").forEach((el) => {
              const sr = el.shadowRoot;
              if (sr) out.push(...collectButtons(sr));
            });
            return out;
          };
          const btns = collectButtons(document);
          const isVisible = (b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const textOf = (b) => (b.innerText || "").trim();
          const strict = btns.find(
            (b) => isVisible(b) && /^(accept( all)?( cookies)?|allow all( cookies)?|accept & close|i agree|alle akzeptieren|tout accepter|aceptar( todo| las cookies)?)\b/i.test(
              textOf(b)
            )
          );
          const loose = btns.find(
            (b) => isVisible(b) && (b.tagName === "BUTTON" || b.tagName === "A") && !/^acceptable/i.test(textOf(b)) && /accept|akzeptieren|tout accepter|aceptar/i.test(textOf(b))
          );
          const accept = strict ?? loose ?? null;
          const allLabels = btns.filter(isVisible).map((b) => `${b.tagName}:${textOf(b).replace(/\s+/g, " ").slice(0, 60)}`).filter((s) => s.length > "BUTTON:".length);
          const nearMiss = allLabels.filter((s) => /accept|cookie|consent|agree|allow|opt.?in|got it/i.test(s));
          const labels = [.../* @__PURE__ */ new Set([...nearMiss.slice(0, 15), ...allLabels.slice(0, 8)])];
          if (!accept) return { clicked: false, labels, clickedLabel: null };
          accept.click();
          return { clicked: true, labels, clickedLabel: textOf(accept).replace(/\s+/g, " ").slice(0, 60) };
        }).then((result) => {
          if (result.clicked) {
            cookieClicks += 1;
            lastClickedLabel = result.clickedLabel;
          }
          lastAcceptLabels = result.labels;
          return result;
        });
      } catch {
        return { clicked: false, labels: [], clickedLabel: null };
      }
    };
    const dismissBanner = async (pg) => {
      let clicked = false;
      for (let pass = 0; pass < 2 && remain() > 3e3; pass++) {
        if (!(await tryCookieAccept(pg)).clicked) break;
        clicked = true;
        await waitForDomStable(pg, remain, 1e3, 500);
      }
      if (!clicked) return false;
      let bannerStillUp = false;
      try {
        bannerStillUp = await pg.evaluate(bannerVisibleInPage);
      } catch {
        bannerStillUp = true;
      }
      if (!bannerStillUp) return true;
      if (remain() <= 12e3) return true;
      try {
        await pg.reload({ waitUntil: "domcontentloaded", timeout: Math.max(1e3, remain()) });
      } catch {
      }
      await waitForDomStable(pg, remain, 2e3, 500);
      for (let pass = 0; pass < 2 && remain() > 3e3; pass++) {
        if (!(await tryCookieAccept(pg)).clicked) break;
        await waitForDomStable(pg, remain, 1e3, 500);
      }
      return true;
    };
    await waitForDomStable(page, remain, 2e3, 500);
    if (isBoardUrl(page.url())) {
      return { html: "", searchOutcome: null, searchMs: 0, renderedUrl: page.url(), cookieClicks };
    }
    let dismissedEarly = await dismissBanner(page);
    if (!dismissedEarly) {
      await waitForDomStable(page, remain, SETTLE_CAP_MS, 1e3);
      if (isBoardUrl(page.url())) {
        return { html: "", searchOutcome: null, searchMs: 0, renderedUrl: page.url(), cookieClicks };
      }
      if (remain() > 3e3) {
        await dismissBanner(page);
      }
    }
    if (remain() > 1e3) await tryCookieAccept(page);
    if (remain() > 1e4) {
      for (let i = 0; i < 4 && remain() > 8e3; i++) {
        let up = false;
        try {
          up = await page.evaluate(bannerVisibleInPage);
        } catch {
          up = false;
        }
        if (!up) break;
        if ((await tryCookieAccept(page)).clicked) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    const searchStart = Date.now();
    let searchToggleClicked = null;
    let searchCountryClicked = null;
    let searchGateClicked = null;
    const searchDeadline = Math.min(
      Math.max(deadline, Date.now() + SEARCH_MIN_MS),
      renderStart + RENDER_ABSOLUTE_CAP_MS
    );
    const searchOutcome = await tryPortalSearch(page, searchTerm, searchDeadline, (label) => {
      searchToggleClicked = label;
    }, (label) => {
      searchCountryClicked = label;
    }, (label) => {
      searchGateClicked = label;
    });
    const searchMs = Date.now() - searchStart;
    let searchScan;
    if (searchOutcome === "no-form") {
      try {
        searchScan = summarizeScan(await page.evaluate(scanSearchForm));
      } catch {
        searchScan = void 0;
      }
    }
    if (searchOutcome === "board-redirect") {
      return { html: "", searchOutcome, searchMs, renderedUrl: page.url(), cookieClicks, searchToggleClicked, searchCountryClicked, searchGateClicked };
    }
    const html = await page.content();
    let bannerVisible = false;
    try {
      bannerVisible = await page.evaluate(bannerVisibleInPage);
    } catch {
      bannerVisible = false;
    }
    return {
      html,
      searchOutcome,
      searchMs,
      renderedUrl: page.url(),
      searchScan,
      cookieClicks,
      bannerPresent: bannerTextPresent(html),
      bannerButtons: lastAcceptLabels,
      cookieClickedLabel: lastClickedLabel,
      bannerVisible,
      searchToggleClicked,
      searchCountryClicked,
      searchGateClicked
    };
  } catch {
    return { html: "", searchOutcome: null, searchMs: 0, renderedUrl: "", renderError: "render-failed", cookieClicks };
  } finally {
    try {
      await page?.close();
    } catch {
    }
  }
}

// api/find-jobs.ts
var FETCH_TIMEOUT_MS = 6e3;
var SOFT_DEADLINE_MS = 5e4;
var CONCURRENCY = 5;
var MAX_LIMIT = 25;
var MAX_RENDERS_PER_CALL = 2;
var RENDER_WINDOW_MS = 3e4;
async function fetchText(url, init) {
  const r = await fetch(url, {
    ...init,
    headers: { "User-Agent": "Mozilla/5.0 (JobBoard Finder)", ...init?.headers ?? {} },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function stripTags(text) {
  return text.replace(/<script.*?<\/script>/gis, " ").replace(/<style.*?<\/style>/gis, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_m, hex) => decodeNumericEntity(parseInt(hex, 16))).replace(/&#(\d+);/g, (_m, dec) => decodeNumericEntity(parseInt(dec, 10))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function decodeNumericEntity(n) {
  return Number.isFinite(n) && n > 0 && n <= 1114111 ? String.fromCodePoint(n) : "";
}
function jazzhrWidgetSlug(pageHtml) {
  const m = pageHtml.match(/app\.jazz\.co\/widgets\/basic\/create\/([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}
function greenhouseEmbedSlug(pageHtml) {
  const m = pageHtml.match(/boards\.greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}
function parseGreenhouseJobs(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return (data.jobs ?? []).map((j) => {
    const d = new Date(j.created_at ?? "");
    return {
      title: j.title ?? "",
      location: j.location?.name ?? "",
      url: j.absolute_url ?? "",
      description: stripTags(j.content ?? ""),
      postedDate: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
    };
  });
}
function isolvedIframeUrl(pageHtml) {
  const m = pageHtml.match(/<iframe[^>]*src="([^"]*isolvedhire\.com[^"]*)"/i);
  return m ? m[1] : null;
}
function parseIsolvedIframe(html, pageUrl) {
  const postings = [];
  const re = /<a\s+href="([^"]+)"[^>]*>\s*<div class="job-info">\s*<h4>([^<]+)<\/h4>\s*<ul class="listing-details">\s*<li>([^<]*)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = m[2].trim();
    const liLoc = m[3].trim();
    if (!title) continue;
    let url = null;
    try {
      url = new URL(m[1], pageUrl).href;
    } catch {
      url = null;
    }
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) continue;
    postings.push({
      title,
      location: /\(remote\)|\bremote\b/i.test(title) ? "Remote" : liLoc,
      url,
      description: "",
      postedDate: ""
    });
  }
  return postings;
}
function parseJazzhrWidget(js) {
  const postings = [];
  const blocks = js.split('<div id="resumator-job-job_');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const dateMatch = b.match(/^(\d{4})(\d{2})(\d{2})/);
    const titleMatch = b.match(/resumator-job-title[^>]*>([^<]+)<\/div>/);
    const locMatch = b.match(/resumator-job-location[^>]*>Location:\s*<\/span>\s*([^<]+)/);
    const deptMatch = b.match(/resumator-job-department[^>]*>Department:\s*<\/span>\s*([^<]+)/);
    const linkMatch = b.match(/resumator-job-link[^>]*href="([^"]+)"/);
    const title = (titleMatch?.[1] ?? "").trim();
    if (!title || !linkMatch) continue;
    postings.push({
      title,
      location: (locMatch?.[1] ?? "").trim(),
      url: linkMatch[1].split("?")[0],
      description: (deptMatch?.[1] ?? "").trim(),
      postedDate: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : ""
    });
  }
  return postings;
}
var EXCLUDED_PLACES = ["canada", "mexico", "brazil", "uk", "united kingdom", "london", "europe", "emea", "apac", "singapore", "india", "australia", "germany", "france", "spain", "poland", "portugal", "netherlands", "ireland", "philippines", "colombia", "argentina", "chile", "japan", "korea", "china", "israel", "kenya", "nigeria", "south africa", "new zealand"];
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "do",
  "does",
  "did",
  "we",
  "you",
  "they",
  "he",
  "she",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "my",
  "our",
  "your",
  "their",
  "his",
  "her",
  "not",
  "no",
  "if",
  "but",
  "so",
  "than",
  "then",
  "when",
  "while",
  "who",
  "whom",
  "what",
  "which",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "same",
  "too",
  "very",
  "just",
  "also",
  "over",
  "under",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "again",
  "further",
  "once",
  "here",
  "there",
  "where",
  "why",
  "because",
  "until",
  "per",
  "via",
  "am",
  "experience",
  "experiences",
  "skills",
  "skill",
  "responsibilities",
  "responsible",
  "duties",
  "education",
  "work",
  "worked",
  "working",
  "years",
  "year",
  "strong",
  "excellent",
  "passionate",
  "proven",
  "ability",
  "including",
  "include",
  "includes",
  "team",
  "teams",
  "role",
  "roles",
  "position",
  "positions",
  "company",
  "companies",
  "join",
  "joining",
  "looking",
  "seek",
  "seeking",
  "need",
  "needs",
  "required",
  "requirements",
  "preferred",
  "bonus",
  "plus",
  "etc"
]);
function tokenize(text) {
  const normalized = text.toLowerCase().replace(/\bfront[\s\-]+end\b/g, "frontend").replace(/\bback[\s\-]+end\b/g, "backend");
  return (normalized.match(/[a-z0-9]+/g) ?? []).map(
    (t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") ? t.slice(0, -1) : t
  ).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}
function extractResumeTerms(resumeText) {
  const counts = /* @__PURE__ */ new Map();
  for (const t of tokenize(resumeText)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
}
var SYNONYM_GROUPS = [
  ["developer", "engineer", "programmer"],
  ["frontend", "web", "ui"],
  ["javascript", "js"],
  ["typescript", "ts"],
  ["react", "reactjs"],
  ["service", "support", "help"],
  ["customer", "client", "member"],
  ["agent", "representative", "specialist"],
  ["technical", "technician"],
  ["satisfaction", "success"]
];
function groupMates(word) {
  for (const g of SYNONYM_GROUPS) {
    if (g.includes(word)) return g;
  }
  return [word];
}
var AMBIGUOUS_GROUP_WORDS = /* @__PURE__ */ new Set(["web", "ui", "ts"]);
function matchResumeTerms(postingWords, resumeTerms) {
  const resumeSet = new Set(resumeTerms);
  const credited = /* @__PURE__ */ new Map();
  for (const w of postingWords) {
    if (resumeSet.has(w)) {
      if (!credited.has(w)) {
        credited.set(w, { term: w, via: w, exact: true, ambiguousOnly: false });
      }
      continue;
    }
    for (const mate of groupMates(w)) {
      if (mate !== w && resumeSet.has(mate) && !credited.has(mate)) {
        credited.set(mate, {
          term: mate,
          via: w,
          exact: false,
          ambiguousOnly: AMBIGUOUS_GROUP_WORDS.has(w)
        });
        break;
      }
    }
  }
  return resumeTerms.filter((t) => credited.has(t)).map((t) => credited.get(t));
}
var STATE_NAMES = [
  ["district of columbia", "dc"],
  ["west virginia", "wv"],
  ["north carolina", "nc"],
  ["south carolina", "sc"],
  ["north dakota", "nd"],
  ["south dakota", "sd"],
  ["new hampshire", "nh"],
  ["new jersey", "nj"],
  ["new mexico", "nm"],
  ["new york", "ny"],
  ["rhode island", "ri"],
  ["alabama", "al"],
  ["alaska", "ak"],
  ["arizona", "az"],
  ["arkansas", "ar"],
  ["california", "ca"],
  ["colorado", "co"],
  ["connecticut", "ct"],
  ["delaware", "de"],
  ["florida", "fl"],
  ["georgia", "ga"],
  ["hawaii", "hi"],
  ["idaho", "id"],
  ["illinois", "il"],
  ["indiana", "in"],
  ["iowa", "ia"],
  ["kansas", "ks"],
  ["kentucky", "ky"],
  ["louisiana", "la"],
  ["maine", "me"],
  ["maryland", "md"],
  ["massachusetts", "ma"],
  ["michigan", "mi"],
  ["minnesota", "mn"],
  ["mississippi", "ms"],
  ["missouri", "mo"],
  ["montana", "mt"],
  ["nebraska", "ne"],
  ["nevada", "nv"],
  ["ohio", "oh"],
  ["oklahoma", "ok"],
  ["oregon", "or"],
  ["pennsylvania", "pa"],
  ["tennessee", "tn"],
  ["texas", "tx"],
  ["utah", "ut"],
  ["vermont", "vt"],
  ["virginia", "va"],
  ["washington", "wa"],
  ["wisconsin", "wi"],
  ["wyoming", "wy"]
];
function normalizeStateNames(l) {
  let out = l;
  for (const [name, abbr] of STATE_NAMES) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), ` ${abbr} `);
  }
  return out;
}
var US_EVIDENCE_RES = [
  /\bunited states\b/,
  /\busa\b/,
  /\bu\.s\.a?\b/,
  /\bus-based\b/,
  /\bauthorized to work in the (united states|us)\b/,
  /\beligible to work in the (united states|us)\b/,
  /\bus citizen\b/,
  /\b(based|located|reside|residing) in the united states\b/
];
function hasUsEvidence(text) {
  return US_EVIDENCE_RES.some((re) => re.test(text));
}
var EXCLUDED_PLACES_RE = EXCLUDED_PLACES.join("|");
var NON_US_ONLY_RES = [
  new RegExp(`\\b(${EXCLUDED_PLACES_RE})\\b[^.]{0,60}\\bonly\\b`, "i"),
  new RegExp(`\\bonly\\b[^.]{0,60}\\b(${EXCLUDED_PLACES_RE})\\b`, "i"),
  /\bwill not be considering (?:us|u\.s\.|united states)[- ]based candidates\b/i,
  /\bnot considering (?:us|u\.s\.|united states)[- ]based candidates\b/i
];
function hasNonUsOnlyRestriction(text) {
  return NON_US_ONLY_RES.some((re) => re.test(text));
}
function locationVerdict(loc, bodyText, isUSCompany = false) {
  const body = (bodyText ?? "").toLowerCase();
  const raw = (loc ?? "").toLowerCase();
  if (!raw) {
    if (hasNonUsOnlyRestriction(body)) {
      return { verdict: "reject", flag: "non-US only (stated in posting)" };
    }
    if (/\bremote\b/.test(body) && hasUsEvidence(body)) {
      return { verdict: "ok", flag: "Remote (US, confirmed in posting)" };
    }
    if (isUSCompany) {
      return {
        verdict: "ok",
        flag: /\bremote\b/.test(body) ? "Remote (US company)" : "no location listed \u2014 US company"
      };
    }
    if (/\bremote\b/.test(body)) {
      return { verdict: "review", flag: "Remote (no country stated \u2014 verify)" };
    }
    return { verdict: "review", flag: "no location listed \u2014 verify" };
  }
  const l = normalizeStateNames(raw);
  if (l.includes("hybrid") || l.includes("on-site") || l.includes("onsite") || l.includes("in office")) {
    return { verdict: "reject", flag: "not remote" };
  }
  if (!l.includes("remote")) return { verdict: "reject", flag: "not remote" };
  for (const place of EXCLUDED_PLACES) {
    if (l.includes(place)) return { verdict: "reject", flag: `excluded place: ${place}` };
  }
  const states = l.match(/\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/g) ?? [];
  if (l.includes("united states") || l.includes("usa") || l.includes("remote (usa)") || /\bremote\b.*\bus\b/.test(l) || l.includes("anywhere") || l.includes("nationwide")) {
    return { verdict: "ok", flag: "Remote (US)" };
  }
  if (hasNonUsOnlyRestriction(body)) {
    return { verdict: "reject", flag: "non-US only (stated in posting)" };
  }
  if (states.length > 0 && states.every((s) => s === "tx")) {
    return { verdict: "ok", flag: "Remote (TX only)" };
  }
  if (states.length > 0) return { verdict: "reject", flag: `state-restricted remote: ${[...new Set(states)].join(", ")}` };
  if (hasUsEvidence(body)) {
    return { verdict: "ok", flag: "Remote (US, confirmed in posting)" };
  }
  if (isUSCompany) {
    return { verdict: "ok", flag: "Remote (US company)" };
  }
  return { verdict: "review", flag: "Remote (no country stated \u2014 verify)" };
}
function parsePay(text) {
  const m = text.match(/\$[\d,]{2,}(?:\s*(?:-|–|to)\s*\$?[\d,]{2,})?/);
  return m ? m[0] : "";
}
function portalSearchTerm(resumeText) {
  return extractResumeTerms(resumeText).slice(0, 2).join(" ");
}
var GENERIC_TITLE_TEXT = /^(home|about|about us|careers|jobs|job|contact|contact us|login|sign in|join our team|work with us|open positions|current openings|open roles|all roles|see all jobs|view all jobs|view jobs|see jobs|browse jobs|search jobs|browse all jobs|view openings|see openings|view open positions|all jobs|all positions|explore careers|explore jobs|learn more|apply now|view details|view job|see details)$/i;
function resolvePageLink(href, pageUrl) {
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("mailto:") || h.startsWith("tel:") || h.startsWith("javascript:")) return null;
  try {
    const abs = new URL(h, pageUrl).href;
    return abs.startsWith("http://") || abs.startsWith("https://") ? abs : null;
  } catch {
    return null;
  }
}
function cleanTitle(text) {
  return stripTags(text).replace(/\s+/g, " ").trim();
}
function titleOk(title) {
  if (title.length < 2 || GENERIC_TITLE_TEXT.test(title)) return false;
  if (/^(see|view|browse|explore|find|search|discover)\b/i.test(title) && /\b(jobs?|roles?|openings?|positions?|careers?|opportunities)\b/i.test(title)) return false;
  if (/\b(view (job|details|opening)|apply( now)?|see details|learn more)$/i.test(title)) return false;
  return true;
}
function locationIn(text) {
  let lastLoc = "";
  for (const m of text.matchAll(/Location:\s*([^<\n]{2,60})/gi)) {
    const v = stripTags(m[1]).trim();
    if (v) lastLoc = v;
  }
  if (lastLoc) return lastLoc;
  const cleanSpan = (raw) => {
    const v = stripTags(raw).replace(/\s+/g, " ").trim();
    return v.length >= 2 && v.length <= 80 ? v : "";
  };
  let lastSpan = "";
  for (const m of text.matchAll(
    /<span[^>]*class="[^"]*(?:job-)?location[^"]*"[^>]*>([\s\S]{0,120}?)<\/span>/gi
  )) {
    const v = cleanSpan(m[1]);
    if (v) lastSpan = v;
  }
  if (lastSpan) return lastSpan;
  for (const m of text.matchAll(
    /<(div|p)[^>]*class="([^"]*)"[^>]*>([\s\S]{0,120}?)<\/\1>/gi
  )) {
    const tokens = m[2].split(/\s+/);
    if (!tokens.some((t) => t === "location" || t === "job-location")) continue;
    const v = cleanSpan(m[3]);
    if (v) lastSpan = v;
  }
  if (lastSpan) return lastSpan;
  if (/\bRemote\b/i.test(text)) return "Remote";
  return "";
}
function locationFromJobSlug(rawUrl) {
  let path2 = "";
  try {
    path2 = new URL(rawUrl).pathname;
  } catch {
    return "";
  }
  const segs = path2.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length === 2 && segs[0].toLowerCase() === "jobs") {
    return locationFromTrailingCountrySlug(segs[1]);
  }
  if (segs.length !== 3 || segs[0].toLowerCase() !== "job") return "";
  if (!/^\d+$/.test(segs[2])) return "";
  const tokens = segs[1].split("-").filter(Boolean);
  if (tokens.length < 2) return "";
  if (!tokens.every((t) => /^[A-Za-z0-9]+$/.test(t))) return "";
  const stateOf = (tok) => {
    if (/^[A-Za-z]{2}$/.test(tok)) {
      const abbr = tok.toUpperCase();
      return STATE_NAMES.some(([, a]) => a.toUpperCase() === abbr) ? abbr : "";
    }
    if (tok.length >= 3) {
      const hits = STATE_NAMES.filter(([name]) => name.startsWith(tok.toLowerCase()));
      return hits.length === 1 ? hits[0][1].toUpperCase() : "";
    }
    return "";
  };
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (/^remote$/i.test(first)) {
    const st2 = stateOf(last);
    return st2 ? `Remote, ${st2}` : "Remote";
  }
  const st = stateOf(last);
  if (!st) return "";
  return `${first}, ${st}`;
}
function locationFromTrailingCountrySlug(slug) {
  const tokens = slug.split("-").filter(Boolean);
  if (tokens.length < 3) return "";
  if (!tokens.every((t) => /^[A-Za-z0-9]+$/.test(t))) return "";
  const lower = tokens.map((t) => t.toLowerCase());
  let markerStart = -1;
  let markerEnd = -1;
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "united" && lower[i + 1] === "states") {
      markerStart = i;
      markerEnd = i + 2;
    } else if (lower[i] === "usa" || lower[i] === "us") {
      markerStart = i;
      markerEnd = i + 1;
    }
  }
  if (markerStart < 0) return "";
  const tail = lower.slice(markerEnd);
  const isUuidTail = tail.length === 0 || tail.length === 5 && [8, 4, 4, 4, 12].every((n2, i) => tail[i].length === n2 && /^[0-9a-f]+$/.test(tail[i])) || tail.length === 1 && tail[0].length === 32 && /^[0-9a-f]+$/.test(tail[0]);
  if (!isUuidTail) return "";
  const loc = lower.slice(0, markerStart);
  if (loc.length < 2) return "";
  const stateOfName = (name) => {
    const hit = STATE_NAMES.find(([n2]) => n2 === name);
    return hit ? hit[1].toUpperCase() : "";
  };
  const stateOfAbbr = (tok) => {
    if (!/^[a-z]{2}$/.test(tok)) return "";
    const hit = STATE_NAMES.find(([, a]) => a === tok);
    return hit ? hit[1].toUpperCase() : "";
  };
  let n = loc.length;
  let st = "";
  if (n >= 2) {
    const two = stateOfName(`${loc[n - 2]} ${loc[n - 1]}`);
    if (two) {
      st = two;
      n -= 2;
    }
  }
  if (!st && n >= 1) {
    const one = stateOfName(loc[n - 1]);
    if (one) {
      st = one;
      n -= 1;
    }
  }
  if (n >= 1) {
    const ab = stateOfAbbr(loc[n - 1]);
    if (ab) {
      if (st && ab !== st) return "";
      if (!st) st = ab;
      n -= 1;
    }
  }
  if (!st) {
    return loc[n - 1] === "remote" ? "Remote" : "";
  }
  if (n < 1) return "";
  const city = loc[n - 1];
  if (!/^[a-z]{2,}$/.test(city)) return "";
  if (city === "remote") return `Remote, ${st}`;
  return `${city.charAt(0).toUpperCase()}${city.slice(1)}, ${st}`;
}
function locationFromTitle(title) {
  const t = (title ?? "").trim();
  if (!t) return "";
  const stateAbbrs = new Set(STATE_NAMES.map(([, a]) => a));
  const stateNames = new Set(STATE_NAMES.map(([n]) => n));
  const hasState = (chunk) => {
    const words = chunk.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return words.some((w) => stateAbbrs.has(w) || stateNames.has(w));
  };
  const mA = t.match(
    /\blocation\s*:?\s+([A-Za-z][A-Za-z .',-]*?)(?:\s+united states\b|\s+jobs\b|\s+category\b|\s*$)/i
  );
  if (mA) {
    const chunk = mA[1].trim().replace(/[,.\s]+$/, "");
    if (chunk && hasState(chunk)) return chunk;
  }
  const mB = t.match(/(?:[-–—]|,)\s*([A-Za-z][A-Za-z .'-]*?),\s*([A-Za-z]{2})\s*$/);
  if (mB && stateAbbrs.has(mB[2].toLowerCase())) {
    return `${mB[1].trim()}, ${mB[2].toUpperCase()}`;
  }
  return "";
}
function titleFromJobSlug(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "";
  }
  const segs = u.pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean);
  const SKIP = /* @__PURE__ */ new Set([
    "job",
    "jobs",
    "jobsearch",
    "career",
    "careers",
    "apply",
    "application",
    "details",
    "detail",
    "position",
    "positions",
    "opening",
    "openings",
    "posting",
    "postings",
    "vacancy",
    "vacancies",
    "role",
    "roles",
    "view",
    "search",
    "results",
    "browse",
    "list",
    "en-us",
    "en"
  ]);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (/^\d+$/.test(seg)) continue;
    if (SKIP.has(seg)) continue;
    const words = seg.split("-").map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w && !/^\d+$/.test(w));
    if (words.length < 2) continue;
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return "";
}
var APPLY_HREF = /job|apply|position|opening|detail|career|posting|vacancy|role/i;
function isJunkTitle(title) {
  const t = (title ?? "").trim();
  if (!t) return true;
  if (/\?\s*$/.test(t)) return true;
  if (/\.\s*$/.test(t) && t.split(/\s+/).length >= 6) return true;
  if (/^(next|previous|prev|back|more|load more|show more|view all)$/i.test(t)) return true;
  if (/^(share your (information|info|details)|submit your (information|info|application)|upload your (cv|resume|information|profile)|introduce yourself)\b/i.test(t)) return true;
  if (/^(join|become|apply)\b/i.test(t)) return true;
  if (/^\s*jobs?\b/i.test(t)) return true;
  if (/\b(jobs|careers|openings|positions|roles|opportunities)\s*$/i.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length <= 3 && /\bservices$/i.test(t)) {
    const toks = new Set(tokenize(t));
    const namesServedParty = [...toks].some((w) => CS_SERVED_PARTY_WORDS.has(w));
    const namesRole = [...toks].some((w) => ROLE_WORDS.has(w) && w !== "support");
    if (!namesServedParty && !namesRole) return true;
  }
  return false;
}
var LIST_PATH_WORDS = /^(jobs?|careers?|job-search|jobsearch|find-a-job|find-jobs|search-jobs|search|results|openings|positions|roles|opportunities)$/i;
function isJobDetailUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (isAggregatorUrl(rawUrl)) return false;
  const q = u.searchParams;
  for (const k of ["id", "jobid", "job_id", "gh_jid", "req", "reqid", "job", "position", "posting"]) {
    const v = q.get(k);
    if (v && v.trim()) return true;
  }
  const hostFirstLabel = u.hostname.split(".")[0].toLowerCase();
  if (hostFirstLabel === "blog" || u.pathname.toLowerCase().split("/").filter(Boolean).some((s) => /^(blog|category|categories|tag|tags|news|press|author|authors|events|event)$/.test(s))) {
    return false;
  }
  const segs = u.pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1];
  if (last === "job" && segs.length >= 3 && /^\d+$/.test(segs[segs.length - 3]) && segs[segs.length - 2].split("-").filter(Boolean).length >= 2) {
    return true;
  }
  if (LIST_PATH_WORDS.test(last)) return false;
  if (/^(job|jobs|career|careers)-/i.test(last)) {
    const rest = last.split("-").slice(1);
    if (!rest.some((t) => /^(detail|details|job|position|opening|posting|role|apply|vacancy)$/i.test(t))) {
      return false;
    }
  }
  if (/^(search|results|browse|find|list)/i.test(last) || /[?&]p(ag)?=\d/i.test(rawUrl)) {
    return false;
  }
  if (segs.some((s) => /^(job|jobs|career|careers|position|opening|posting|vacancy|apply|detail|role)/i.test(s))) return true;
  if (/\d/.test(last)) return true;
  if (last.split("-").filter(Boolean).length >= 4) return true;
  return false;
}
function isRealPosting(title, url) {
  if (!url) return false;
  return !isJunkTitle(title) && isJobDetailUrl(url);
}
function parseCareersPage(html, pageUrl) {
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const pageLocation = isJobDetailUrl(pageUrl) ? locationIn(clean) || jsonLdFirstJobLocation(html) : "";
  const postings = [];
  const seen = /* @__PURE__ */ new Set();
  const seenUrls = /* @__PURE__ */ new Set();
  const push = (title, location, url) => {
    if (!titleOk(title) || !url) return;
    if (!isRealPosting(title, url)) return;
    const key = `${title}
${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenUrls.add(url);
    postings.push({ title, location: location || locationFromJobSlug(url) || pageLocation, url, description: "", postedDate: "" });
  };
  const chunks = clean.split(/(?=<[^>]*\b(?:(?:class|id)="[^"]*(?:job(?!-location)|career|position|opening)[^"]*"|data-job-id="[^"]+"))/i);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].slice(0, 3e3);
    const heading = chunk.match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    const strong = chunk.match(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/i);
    const link = chunk.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/i);
    let title = "";
    if (heading) title = cleanTitle(heading[1]);
    if (!titleOk(title) && link) title = cleanTitle(link[2]);
    if (!titleOk(title) && strong) title = cleanTitle(strong[1]);
    if (!titleOk(title)) continue;
    let apply = null;
    let first = null;
    const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(chunk)) !== null) {
      const abs = resolvePageLink(lm[1], pageUrl);
      if (!abs) continue;
      if (!first) first = abs;
      if (APPLY_HREF.test(lm[1])) {
        apply = abs;
        break;
      }
    }
    if (!apply) apply = first;
    const loc = locationIn(chunk);
    if (!apply) continue;
    if (!APPLY_HREF.test(apply) && !loc) continue;
    push(title, loc, apply);
  }
  const cardAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let cm;
  while ((cm = cardAnchorRe.exec(clean)) !== null) {
    const openTag = cm[0].slice(0, cm[0].indexOf(">") + 1);
    if (!/\bclass="[^"]*(?:job|career|position|opening)/i.test(openTag)) continue;
    const cardHeading = cm[2].match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    if (!cardHeading) continue;
    const cardTitle = cleanTitle(cardHeading[1]);
    if (!titleOk(cardTitle)) continue;
    const cardApply = resolvePageLink(cm[1], pageUrl);
    if (!cardApply) continue;
    const cardLoc = locationIn(cm[2]);
    if (!APPLY_HREF.test(cardApply) && !cardLoc) continue;
    push(cardTitle, cardLoc, cardApply);
  }
  const tbAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let tm;
  while ((tm = tbAnchorRe.exec(clean)) !== null) {
    const tbOpenTag = tm[0].slice(0, tm[0].indexOf(">") + 1);
    if (!/\bdata-job-id=["']\d+["']/i.test(tbOpenTag)) continue;
    const tbHeading = tm[2].match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    if (!tbHeading) continue;
    const tbTitle = cleanTitle(tbHeading[1]);
    if (!titleOk(tbTitle)) continue;
    const tbApply = resolvePageLink(tm[1], pageUrl);
    if (!tbApply) continue;
    const tbLocSpan = tm[2].match(
      /<span[^>]*class="[^"]*job-location[^"]*"[^>]*>([\s\S]{0,120}?)<\/span>/i
    );
    const tbLoc = tbLocSpan ? stripTags(tbLocSpan[1]).trim() : locationIn(tm[2]);
    if (!APPLY_HREF.test(tbApply) && !tbLoc) continue;
    push(tbTitle, tbLoc, tbApply);
  }
  const uuidAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let um;
  while ((um = uuidAnchorRe.exec(clean)) !== null) {
    if (!/\/jobs?\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(um[1])) continue;
    const uuidApply = resolvePageLink(um[1], pageUrl);
    if (!uuidApply) continue;
    let uuidTitle = "";
    for (const seg of um[2].split(/<[^>]+>/g)) {
      const t = cleanTitle(seg);
      if (!titleOk(t)) continue;
      if (/\bremote\b/i.test(t)) continue;
      if (/^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(t)) continue;
      uuidTitle = t;
      break;
    }
    if (!uuidTitle) continue;
    const uuidLoc = locationIn(um[2]);
    if (!APPLY_HREF.test(uuidApply) && !uuidLoc) continue;
    push(uuidTitle, uuidLoc, uuidApply);
  }
  const CTA_TEXT = /^(apply\s*now|apply|view\s*job|view\s*details?|see\s*details?|see\s*job|view\s*opening|view\s*role)\b/i;
  const applyAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let fm;
  while ((fm = applyAnchorRe.exec(clean)) !== null) {
    const ctaText = cleanTitle(fm[2]);
    if (!CTA_TEXT.test(ctaText)) continue;
    const applyUrl = resolvePageLink(fm[1], pageUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) continue;
    if (!isJobDetailUrl(applyUrl)) continue;
    const slugTitle = titleFromJobSlug(applyUrl);
    if (!titleOk(slugTitle)) continue;
    push(slugTitle, "", applyUrl);
  }
  const viewRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let vm;
  while ((vm = viewRe.exec(clean)) !== null) {
    if (!/view details|view job|apply|see details|learn more/i.test(cleanTitle(vm[2]))) continue;
    const apply = resolvePageLink(vm[1], pageUrl);
    if (!apply) continue;
    const windowText = clean.slice(Math.max(0, vm.index - 900), vm.index);
    const headings = [...windowText.matchAll(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/gi)];
    const bolds = [...windowText.matchAll(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/gi)];
    let title = "";
    const lastHeading = headings[headings.length - 1];
    if (lastHeading) title = cleanTitle(lastHeading[1]);
    if (!titleOk(title)) {
      const lastBold = bolds[bolds.length - 1];
      if (lastBold) title = cleanTitle(lastBold[1]);
    }
    if (!titleOk(title)) continue;
    const loc = locationIn(windowText);
    if (!APPLY_HREF.test(apply) && !loc) continue;
    push(title, loc, apply);
  }
  return postings.slice(0, 50);
}
function locationFromJobLocation(jl) {
  if (!jl) return "";
  if (typeof jl === "string") return jl.trim();
  if (Array.isArray(jl)) {
    for (const item of jl) {
      const s = locationFromJobLocation(item);
      if (s) return s;
    }
    return "";
  }
  if (typeof jl === "object") {
    const addr = jl.address;
    if (addr && typeof addr === "object") {
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
      if (parts.length > 0) return parts.join(", ");
    }
    if (typeof jl.name === "string") return jl.name.trim();
  }
  return "";
}
function requirementText(req) {
  if (!req) return "";
  if (typeof req === "string") return req.trim();
  if (Array.isArray(req)) {
    for (const item of req) {
      const s = requirementText(item);
      if (s) return s;
    }
    return "";
  }
  if (typeof req === "object" && typeof req.name === "string") return req.name.trim();
  return "";
}
function jobPostingLocation(j) {
  const locType = j.jobLocationType;
  const locTypes = Array.isArray(locType) ? locType : [locType];
  const telecommute = locTypes.some(
    (t) => typeof t === "string" && t.toUpperCase().includes("TELECOMMUTE")
  );
  const reqText = requirementText(j.applicantLocationRequirements);
  if (telecommute) return reqText ? `Remote, ${reqText}` : "Remote";
  return locationFromJobLocation(j.jobLocation) || reqText;
}
function jsonLdFirstJobLocation(html) {
  const nodes = [];
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) collect(n);
      return;
    }
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("JobPosting")) {
      nodes.push(node);
      return;
    }
    if (node["@graph"]) collect(node["@graph"]);
  };
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    try {
      collect(JSON.parse(sm[1]));
    } catch {
    }
  }
  if (nodes.length !== 1) return "";
  return jobPostingLocation(nodes[0]);
}
function parseJsonLdPostings(html, pageUrl) {
  const postings = [];
  const pushPosting = (j) => {
    const title = typeof j.title === "string" ? cleanTitle(j.title) : "";
    if (!titleOk(title)) return;
    let url = null;
    if (typeof j.url === "string" && j.url.trim()) {
      try {
        const abs = new URL(j.url.trim(), pageUrl).href;
        if (abs.startsWith("http://") || abs.startsWith("https://")) url = abs;
      } catch {
      }
    }
    if (!url || isBoardUrl(url)) return;
    if (typeof j.validThrough === "string") {
      const vt = new Date(j.validThrough);
      if (!Number.isNaN(vt.getTime()) && vt.getTime() < Date.now()) return;
    }
    const description = typeof j.description === "string" ? stripTags(j.description) : "";
    const location = jobPostingLocation(j);
    let postedDate = "";
    if (typeof j.datePosted === "string") {
      const d = new Date(j.datePosted);
      if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
    }
    postings.push({ title, location, url, description, postedDate });
  };
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) collect(n);
      return;
    }
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("JobPosting")) {
      pushPosting(node);
      return;
    }
    if (node["@graph"]) collect(node["@graph"]);
  };
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null) {
    try {
      collect(JSON.parse(sm[1]));
    } catch {
    }
  }
  return postings.slice(0, 50);
}
function careersLinksOnPage(html, pageUrl) {
  const out = [];
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/gi, "&").replace(/&#0?38;/gi, "&").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    const text = stripTags(m[2]).trim();
    const hrefHits = /career|job/i.test(href);
    const textHits = /career|job|open positions|join (us|our|the) team|work with us/i.test(text);
    if (!hrefHits && !textHits) continue;
    try {
      const abs = new URL(href, pageUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
    }
  }
  return out.slice(0, 3);
}
function nextPageUrl(html, pageUrl) {
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const text = stripTags(m[2]).replace(/[^a-z]/gi, "").toLowerCase();
    const isNext = text === "next" || /\brel=["']?next["']?/i.test(openTag) || /\bclass=["'][^"']*\bnext\b[^"']*["']/i.test(openTag);
    if (!isNext) continue;
    const abs = resolvePageLink(m[1].replace(/&amp;/gi, "&"), pageUrl);
    if (!abs || isBoardUrl(abs)) continue;
    try {
      if (new URL(abs).hostname !== new URL(pageUrl).hostname) continue;
    } catch {
      continue;
    }
    if (abs.replace(/\/+$/, "") === pageUrl.replace(/\/+$/, "")) continue;
    return abs;
  }
  return null;
}
async function collectPagePostings(html, pageUrl, rendered) {
  const pagePostings = [];
  const seenKeys = /* @__PURE__ */ new Set();
  const addPostings = (ps, source) => {
    for (const p of ps) {
      const k = `${p.title}
${p.url}`;
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        pagePostings.push({ ...p, source });
      }
    }
  };
  addPostings(parseCareersPage(html, pageUrl), rendered ? "rendered" : "html");
  if (pagePostings.length > 0) {
    const seenPages = /* @__PURE__ */ new Set([pageUrl.replace(/\/+$/, "")]);
    let nextUrl = nextPageUrl(html, pageUrl);
    let extraPages = 0;
    while (nextUrl && extraPages < 3 && !seenPages.has(nextUrl.replace(/\/+$/, ""))) {
      seenPages.add(nextUrl.replace(/\/+$/, ""));
      let nextHtml;
      try {
        nextHtml = await fetchText(nextUrl);
      } catch {
        break;
      }
      const before = pagePostings.length;
      addPostings(parseCareersPage(nextHtml, nextUrl), rendered ? "rendered" : "html");
      extraPages += 1;
      if (pagePostings.length === before) break;
      if (pagePostings.length >= 50) break;
      nextUrl = nextPageUrl(nextHtml, nextUrl);
    }
  }
  const widgetSlug = jazzhrWidgetSlug(html);
  if (widgetSlug) {
    try {
      addPostings(
        parseJazzhrWidget(
          await fetchText(`https://app.jazz.co/widgets/basic/create/${widgetSlug}`)
        ),
        "jazzhr"
      );
    } catch {
    }
  }
  const iframeUrl = isolvedIframeUrl(html);
  if (iframeUrl) {
    try {
      addPostings(parseIsolvedIframe(await fetchText(iframeUrl), iframeUrl), "isolved");
    } catch {
    }
  }
  const ghSlug = greenhouseEmbedSlug(html);
  if (ghSlug) {
    try {
      addPostings(
        parseGreenhouseJobs(
          await fetchText(
            `https://boards-api.greenhouse.io/v1/boards/${ghSlug}/jobs?content=true`
          )
        ),
        "greenhouse"
      );
    } catch {
    }
  }
  const byTitle = new Map(pagePostings.map((p) => [p.title.toLowerCase(), p]));
  for (const jp of parseJsonLdPostings(html, pageUrl)) {
    const vis = byTitle.get(jp.title.toLowerCase());
    if (vis) {
      if (!vis.description && jp.description) vis.description = jp.description;
      if (!vis.location && jp.location) vis.location = jp.location;
      if (!vis.postedDate && jp.postedDate) vis.postedDate = jp.postedDate;
    } else {
      addPostings([jp], "jsonld");
    }
  }
  return pagePostings;
}
var ATS_HOST_SIGNS = [
  "myworkdayjobs",
  "rippling",
  "paylocity",
  "smartrecruiters",
  "icims",
  "taleo",
  "successfactors",
  "eightfold",
  "phenom",
  "brassring",
  "adp",
  "ultipro",
  "breezy",
  "workable",
  "fountain",
  "talentbrew",
  "radancy",
  "avature",
  "jobvite",
  "recruitee",
  "clearcompany",
  "dayforce",
  "peoplefluent",
  "lumesse",
  "harri",
  "hiringthing",
  "teamtailor",
  "personio",
  "jobadder",
  "bling-ai"
];
function atsHostBonus(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return ATS_HOST_SIGNS.some((s) => host.includes(s)) ? 8 : 0;
  } catch {
    return 0;
  }
}
var APPLY_HOST_SIGNS = [
  ...ATS_HOST_SIGNS,
  "paycor",
  "e3applicants",
  "isolvedhire",
  "greenhouse",
  "lever",
  "ashbyhq",
  "jazz",
  "applytojob"
];
function isAllowedApplyHost(url, companyHosts) {
  if (!url || isAggregatorUrl(url)) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const h of companyHosts) {
    const hh = h.toLowerCase();
    if (host === hh || host.endsWith(`.${hh}`)) return true;
    const parts = hh.split(".");
    if (parts.length >= 3) {
      const apex = parts.slice(1).join(".");
      if (host === apex || host.endsWith(`.${apex}`)) return true;
    }
  }
  if (host === "governmentjobs.com" || host.endsWith(".governmentjobs.com")) return true;
  if (host.endsWith(".gov")) return true;
  return APPLY_HOST_SIGNS.some((s) => host.includes(s));
}
function renderTargetScore(u, careersUrl) {
  let score = 0;
  try {
    const parsed = new URL(u);
    const path2 = parsed.pathname.toLowerCase();
    if (/job-search|search-results|\/results(\/|$)/.test(path2)) score += 7;
    else if (/search/.test(path2)) score += 4;
    else if (/jobs?|careers?/.test(path2)) score += 2;
    const firstLabel = parsed.hostname.split(".")[0].toLowerCase();
    if ((firstLabel === "jobs" || firstLabel === "careers") && path2 === "/") score += 6;
    const locale = parsed.searchParams.get("locale") || parsed.searchParams.get("lang") || parsed.searchParams.get("language") || "";
    const lang = locale.split(/[-_]/)[0].toLowerCase();
    if (lang && lang !== "en") score -= 4;
    if (isAtsListUrl(u)) score += 2;
  } catch {
  }
  if (careersUrl && u === careersUrl) score += 2;
  return score + atsHostBonus(u);
}
function portalContentScore(html) {
  let score = 0;
  const withoutSiteSearch = html.replace(
    /<form[^>]*\baction\s*=\s*["']\/["'][^>]*>[\s\S]*?<\/form\s*>/gi,
    " "
  );
  if (/<input[^>]*\b(name|id|placeholder|aria-label|class)\s*=\s*["'][^"']*(keyword|job[^"']*search|search[^"']*(job|career|position|title|role)|career[^"']*search)/i.test(
    withoutSiteSearch
  )) {
    score += 5;
  } else if (/<input[^>]*\bname\s*=\s*["']q["']/i.test(withoutSiteSearch)) {
    score += 3;
  }
  if (jazzhrWidgetSlug(html) || greenhouseEmbedSlug(html) || isolvedIframeUrl(html)) score += 5;
  if (/job-card|jobsData|job-list|job_list|jobList/i.test(html)) score += 3;
  let detailLinks = 0;
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      if (isJobDetailUrl(new URL(href, "https://example.com").href)) {
        detailLinks += 1;
        if (detailLinks >= 2) break;
      }
    } catch {
    }
  }
  if (detailLinks >= 2) score += 5;
  return score;
}
function companyHostBonus(u, companyName) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    const name = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!name || name.length < 3) return 0;
    for (const label of host.split(".")) {
      const clean = label.replace(/[^a-z0-9]+/g, "");
      if (clean === name) return 3;
      if (name.length >= 4 && clean.startsWith(name)) return 3;
    }
    return 0;
  } catch {
    return 0;
  }
}
function isAtsListUrl(rawUrl) {
  try {
    return /\/jobs\/all(\/|$)/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}
function isJunkRenderPath(rawUrl) {
  try {
    const segs = new URL(rawUrl).pathname.toLowerCase().split("/").filter(Boolean);
    return segs.some(
      (s) => /^(blog|category|categories|tag|tags|news|press|author|authors|events|event)$/.test(s)
    );
  } catch {
    return false;
  }
}
function isCareersLikeUrl(u, careersUrl) {
  if (careersUrl && u === careersUrl) return true;
  try {
    const parsed = new URL(u);
    if (/career|job/i.test(parsed.pathname)) return true;
    const firstLabel = parsed.hostname.split(".")[0] || "";
    return /^(jobs|careers)$/i.test(firstLabel);
  } catch {
    return false;
  }
}
function isListLikeUrl(u, careersUrl) {
  if (careersUrl && u === careersUrl) return true;
  try {
    const parsed = new URL(u);
    const segs = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    return segs.some(
      (s) => /^(careers?|jobs?|job-search|jobsearch|find-a-job|find-jobs|search-jobs|search|results|openings|positions|roles|opportunities)$/i.test(s)
    );
  } catch {
    return false;
  }
}
function sampleRenderedText(html) {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim().slice(0, 300);
}
async function searchCompanyJobs(company, resumeText, opts = {}) {
  const careersUrl = company.careersUrl || "";
  const website = company.website || "";
  const allowedHosts = [];
  for (const site of [website, careersUrl]) {
    const d = site ? domainOf(site) : "";
    if (d && !allowedHosts.includes(d)) allowedHosts.push(d);
  }
  const triedUrls = [];
  const candidates = [];
  if (careersUrl && !isBoardUrl(careersUrl)) candidates.push(careersUrl);
  if (website && !isBoardUrl(website)) {
    const base = website.replace(/\/$/, "");
    for (const u of [website, `${base}/careers`, `${base}/jobs`]) {
      if (!candidates.includes(u)) candidates.push(u);
    }
    try {
      const host = new URL(website).hostname.toLowerCase();
      if (/^(jobs|careers)\./.test(host)) {
        const apex = `https://${host.split(".").slice(1).join(".")}`;
        if (!candidates.includes(apex) && !isBoardUrl(apex)) candidates.push(apex);
      }
    } catch {
    }
  }
  const renderBudget = opts.renderBudget ?? { used: 0, max: 2 };
  const renderDeadlineMs = opts.renderDeadlineMs ?? Date.now() + RENDER_WINDOW_MS;
  let anyFetchOk = false;
  let renderUsed = false;
  let renderAttempted = false;
  let renderMs = 0;
  let renderError = null;
  let renderTextSample = "";
  let searchOutcome = null;
  let searchScan = null;
  let searchMs = 0;
  let renderedUrl = "";
  let renderAttempts = [];
  let renderTargets = [];
  let fallbackPostings = null;
  let renderFallback = null;
  const readWithPostings = /* @__PURE__ */ new Set();
  const zeroYieldTargets = [];
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i];
    triedUrls.push(u);
    let html;
    try {
      html = await fetchText(u);
      anyFetchOk = true;
    } catch {
      if (isCareersLikeUrl(u, careersUrl) || atsHostBonus(u) > 0) {
        if ((!isJobDetailUrl(u) || isAtsListUrl(u)) && !isJunkRenderPath(u)) {
          zeroYieldTargets.push({
            url: u,
            score: renderTargetScore(u, careersUrl) + companyHostBonus(u, company.name)
          });
        }
      }
      continue;
    }
    const pagePostings = await collectPagePostings(html, u, false);
    if (pagePostings.length > 0) {
      const isTeaser = pagePostings.length === 1 && (!isListLikeUrl(u, careersUrl) || zeroYieldTargets.length > 0);
      if (isTeaser) {
        if (!fallbackPostings) fallbackPostings = { postings: pagePostings, url: u };
      } else {
        readWithPostings.add(u);
        const screened = screenPostings(company.name, pagePostings, resumeText, company.isUSCompany ?? false, allowedHosts);
        if (screened.leads.length === 0 && screened.rejectedLocation === 0) {
          if (!fallbackPostings) fallbackPostings = { postings: pagePostings, url: u };
        } else {
          return {
            leads: screened.leads,
            postingsSeen: pagePostings.length,
            sourcePage: u,
            triedUrls,
            fetchOk: true,
            screened: {
              rejectedNoMatch: screened.rejectedNoMatch,
              rejectedLocation: screened.rejectedLocation,
              reviewLocation: screened.reviewLocation,
              rejected: screened.rejected
            },
            renderUsed,
            renderAttempted,
            renderMs,
            renderError,
            searchOutcome,
            searchScan,
            searchMs,
            renderedUrl,
            renderTextSample,
            renderAttempts,
            renderTargets
          };
        }
      }
    }
    const contentScore = portalContentScore(html);
    if ((contentScore > 0 || isCareersLikeUrl(u, careersUrl) || atsHostBonus(u) > 0) && (!isJobDetailUrl(u) || isAtsListUrl(u)) && !isJunkRenderPath(u)) {
      zeroYieldTargets.push({
        url: u,
        score: renderTargetScore(u, careersUrl) + contentScore + companyHostBonus(u, company.name) - (readWithPostings.has(u) ? 10 : 0)
      });
    }
    let at = i + 1;
    for (const link of careersLinksOnPage(html, u)) {
      if (!isBoardUrl(link) && candidates.length < 8 && !candidates.includes(link) && !triedUrls.includes(link)) {
        candidates.splice(at, 0, link);
        at++;
      }
    }
  }
  if (zeroYieldTargets.length > 0 && opts.renderPage) {
    const targets = [...zeroYieldTargets].sort((a, b) => b.score - a.score);
    renderTargets = targets.map((t) => ({ url: t.url, score: t.score }));
    for (const { url: target } of targets) {
      if (renderBudget.used >= renderBudget.max || Date.now() >= renderDeadlineMs) break;
      let rendered = null;
      let attemptMs = 0;
      for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
        if (attemptNo === 0) {
          if (renderBudget.used >= renderBudget.max || Date.now() >= renderDeadlineMs) break;
          renderBudget.used += 1;
        } else if (Date.now() >= renderDeadlineMs) {
          break;
        }
        renderAttempted = true;
        const started = Date.now();
        let attemptRendered = null;
        try {
          attemptRendered = await opts.renderPage(target, portalSearchTerm(resumeText));
        } catch {
          attemptRendered = null;
        }
        attemptMs = Date.now() - started;
        renderMs += attemptMs;
        renderAttempts.push({
          target,
          ms: attemptMs,
          outcome: attemptRendered?.searchOutcome ?? null,
          error: attemptRendered ? attemptRendered.renderError ?? null : "render-null",
          renderedUrl: attemptRendered?.renderedUrl ?? "",
          cookieClicks: attemptRendered?.cookieClicks ?? 0,
          bannerPresent: attemptRendered?.bannerPresent ?? false,
          bannerButtons: attemptRendered?.bannerButtons ?? [],
          cookieClickedLabel: attemptRendered?.cookieClickedLabel ?? null,
          bannerVisible: attemptRendered?.bannerVisible ?? false,
          searchToggleClicked: attemptRendered?.searchToggleClicked ?? null,
          searchCountryClicked: attemptRendered?.searchCountryClicked ?? null,
          searchGateClicked: attemptRendered?.searchGateClicked ?? null
        });
        rendered = attemptRendered;
        const failedFast = !attemptRendered?.html && (attemptRendered?.renderError || attemptRendered?.searchOutcome == null) && attemptMs < 5e3;
        if (attemptNo === 0 && failedFast) {
          renderBudget.used -= 1;
          continue;
        }
        break;
      }
      if (!rendered) {
        continue;
      }
      searchOutcome = rendered.searchOutcome;
      searchScan = rendered.searchScan ?? null;
      searchMs = rendered.searchMs;
      renderedUrl = rendered.renderedUrl;
      renderError = rendered.renderError ?? null;
      if (rendered.html) {
        renderTextSample = sampleRenderedText(rendered.html);
        const pagePostings = await collectPagePostings(
          rendered.html,
          rendered.renderedUrl || target,
          true
        );
        if (pagePostings.length > 0) {
          renderUsed = true;
          const screened = screenPostings(company.name, pagePostings, resumeText, company.isUSCompany ?? false, allowedHosts);
          if (screened.leads.length === 0 && screened.rejectedLocation === 0) {
            if (!fallbackPostings && !renderFallback) renderFallback = { postings: pagePostings, url: target };
            if (searchOutcome === "has-listings") break;
            continue;
          }
          return {
            // Stamp the search flag: these listings came out of a
            // portal search submit, not the plain walk.
            leads: screened.leads.map((l) => ({ ...l, searched: searchOutcome === "searched" })),
            postingsSeen: pagePostings.length,
            sourcePage: target,
            triedUrls,
            fetchOk: true,
            screened: {
              rejectedNoMatch: screened.rejectedNoMatch,
              rejectedLocation: screened.rejectedLocation,
              reviewLocation: screened.reviewLocation,
              rejected: screened.rejected
            },
            renderUsed,
            renderAttempted,
            renderMs,
            renderError,
            searchOutcome,
            searchScan,
            searchMs,
            renderedUrl,
            renderTextSample,
            renderAttempts,
            renderTargets
          };
        }
      }
      const failedRender = !rendered.html && (renderError !== null || searchOutcome === null);
      if (failedRender || searchOutcome === "no-form") continue;
      break;
    }
  }
  const fb = fallbackPostings ?? renderFallback;
  if (fb) {
    const screened = screenPostings(company.name, fb.postings, resumeText, company.isUSCompany ?? false, allowedHosts);
    return {
      leads: screened.leads,
      postingsSeen: fb.postings.length,
      sourcePage: fb.url,
      triedUrls,
      fetchOk: anyFetchOk,
      screened: {
        rejectedNoMatch: screened.rejectedNoMatch,
        rejectedLocation: screened.rejectedLocation,
        reviewLocation: screened.reviewLocation,
        rejected: screened.rejected
      },
      renderUsed,
      renderAttempted,
      renderMs,
      renderError,
      searchOutcome,
      searchScan,
      searchMs,
      renderedUrl,
      renderTextSample,
      renderAttempts,
      renderTargets
    };
  }
  return {
    leads: [],
    postingsSeen: 0,
    sourcePage: null,
    triedUrls,
    fetchOk: anyFetchOk,
    screened: { rejectedNoMatch: 0, rejectedLocation: 0, reviewLocation: 0, rejected: [] },
    renderUsed,
    renderAttempted,
    renderMs,
    renderError,
    searchOutcome,
    searchScan,
    searchMs,
    renderedUrl,
    renderTextSample,
    renderAttempts,
    renderTargets
  };
}
function extractYears(text) {
  let max = null;
  const take = (n) => {
    if (n >= 1 && n <= 50 && (max === null || n > max)) max = n;
  };
  for (const m of text.matchAll(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience/gi)) take(+m[1]);
  for (const m of text.matchAll(/(?:experience|required|minimum|at least)[^.\n]{0,50}?(\d+)\+?\s*(?:years?|yrs?)\b/gi)) take(+m[1]);
  for (const m of text.matchAll(/(\d+)\+?\s*(?:years?|yrs?)\s+(?:in|of|with)\b/gi)) take(+m[1]);
  return max;
}
function extractRequiredSkills(description, resumeSet) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const triggers = /(?:experience with|experience in|experience using|proficiency in|proficiency with|knowledge of|skilled in|expertise in|familiarity with|must have)\s+([A-Za-z][A-Za-z0-9+#./&\- ]{1,60}?)(?:,|;|\.|$)/gi;
  let m;
  while ((m = triggers.exec(description)) !== null && out.length < 3) {
    for (const raw of m[1].split(/\s+and\s+|\s+or\s+|,/)) {
      let piece = raw.trim().replace(/\s+(experience|required|preferred|skills?)$/i, "").trim();
      if (!piece || piece.split(/\s+/).length > 3) continue;
      const key = piece.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (tokenize(piece).every((t) => resumeSet.has(t))) continue;
      out.push(piece);
      if (out.length >= 3) break;
    }
  }
  return out;
}
var CS_FUNCTION_WORDS = /* @__PURE__ */ new Set([
  "service",
  "support",
  "customer",
  "client",
  "member",
  "patient",
  "guest",
  "help",
  "call",
  "billing"
]);
var CS_ROLE_QUALIFIERS = /* @__PURE__ */ new Set([
  "customer",
  "client",
  "member",
  "patient",
  "guest",
  "support",
  "help",
  "call",
  "billing"
]);
var CS_TECH_ROLE_WORDS = /* @__PURE__ */ new Set(["engineer", "developer", "designer", "director", "lead"]);
var CS_SERVED_PARTY_WORDS = /* @__PURE__ */ new Set(["customer", "client", "member", "patient", "guest", "user"]);
var ROLE_WORDS = /* @__PURE__ */ new Set([
  "representative",
  "agent",
  "specialist",
  "manager",
  "coordinator",
  "associate",
  "technician",
  "analyst",
  "clerk",
  "supervisor",
  // 'support' IS the role: 'Customer Service Support', 'Technical
  // Customer Support' and 'Phone Support' name no other role word,
  // so without it the gate rejects real CS roles outright (ModSquad,
  // 2026-11-12 canary: all three died as no-match). The score
  // formula still holds the 60 line — a bare 'Sales Support' matches
  // one resume term and scores 55, a near-miss, never an auto-add.
  "support",
  "assistant",
  "advisor",
  "consultant",
  "engineer",
  "developer",
  "designer",
  "director",
  "lead",
  "intern",
  "trainer",
  "advocate",
  "liaison",
  "officer",
  "aide",
  "worker",
  "counselor",
  "operator",
  "attendant",
  "nurse",
  // 'teacher' was here and is deliberately NOT a role word: a
  // teaching role ('Certified Teacher of the Visually Impaired ...
  // Specialist - Washington Service') passed the CS gate on
  // 'teacher' + 'service' (2026-11-12 verify-401) — no real CS
  // role is titled Teacher, and 'specialist' in the same title
  // still needs its own qualifier.
  // 'expert' IS the role at iCIMS-style boards: Teleperformance titles
  // its reps 'Customer Service Expert' / 'Customer Expert' — without
  // it the gate rejects a real CS role outright (2026-11-12 probe).
  // The gate still requires a literal CS word, and the score still
  // holds the 60 line (a bare 'Customer Expert' matches one resume
  // term and scores 55, a near-miss).
  "expert"
]);
var WIDGET_SOURCES = /* @__PURE__ */ new Set(["jazzhr", "isolved", "greenhouse", "jsonld"]);
function screenPostings(company, postings, resumeText, isUSCompany = false, allowedHosts = []) {
  const resumeTerms = extractResumeTerms(resumeText);
  const resumeSet = new Set(resumeTerms);
  const resumeYears = extractYears(resumeText);
  const leads = [];
  let rejectedNoMatch = 0;
  let rejectedLocation = 0;
  let reviewLocation = 0;
  const rejected = [];
  const noteRejected = (p, reason) => {
    if (rejected.length < 10) rejected.push({ title: p.title, location: p.location || "", reason });
  };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const isCsResume = resumeSet.has("customer") && resumeSet.has("service");
  for (const p of postings) {
    const postingWords = new Set(tokenize(`${p.title} ${p.description}`));
    const matches = matchResumeTerms(postingWords, resumeTerms);
    if (matches.length === 0 || !matches.some((m) => !m.ambiguousOnly)) {
      rejectedNoMatch += 1;
      noteRejected(p, "no-match");
      continue;
    }
    if (allowedHosts.length > 0 && p.url && !(p.source && WIDGET_SOURCES.has(p.source)) && !isAllowedApplyHost(p.url, allowedHosts)) {
      rejectedNoMatch += 1;
      noteRejected(p, "no-match");
      continue;
    }
    if (isCsResume) {
      const gateTitle = p.title.replace(/\s+[–—-]\s+[^–—\n-]*\b(division|department)\b[^\n]*$/i, "").replace(/\bon-call\b/gi, "oncall");
      const titleWords = new Set(tokenize(gateTitle));
      const namesCsWork = [...titleWords].some((w) => CS_FUNCTION_WORDS.has(w));
      const namesTechRole = [...titleWords].some((w) => CS_TECH_ROLE_WORDS.has(w));
      const namesRole = namesTechRole ? [...titleWords].some((w) => CS_SERVED_PARTY_WORDS.has(w)) : [...titleWords].some((w) => {
        if (!ROLE_WORDS.has(w)) return false;
        if (w === "specialist" || w === "technician") {
          return [...titleWords].some((q) => CS_ROLE_QUALIFIERS.has(q));
        }
        return true;
      });
      if (!namesCsWork || !namesRole) {
        rejectedNoMatch += 1;
        noteRejected(p, "no-match");
        continue;
      }
    }
    const effLoc = p.location || locationFromTitle(p.title);
    const loc = locationVerdict(effLoc, `${p.title} ${p.description}`, isUSCompany);
    if (loc.verdict === "reject") {
      rejectedLocation += 1;
      noteRejected(p, "location");
      continue;
    }
    const needsReview = loc.verdict === "review";
    if (needsReview) reviewLocation += 1;
    const titleMatches = matchResumeTerms(new Set(tokenize(p.title)), resumeTerms);
    const titleMatchedTerms = new Set(titleMatches.map((m) => m.term));
    const descOnlyCount = matchResumeTerms(new Set(tokenize(p.description)), resumeTerms).filter(
      (m) => !titleMatchedTerms.has(m.term)
    ).length;
    const creditedMatches = titleMatches.length + Math.min(descOnlyCount, 5);
    const overlap = resumeTerms.length === 0 ? 0 : creditedMatches / Math.min(resumeTerms.length, 10);
    const matchScore = Math.min(100, Math.round(50 + 50 * overlap));
    const descCounts = /* @__PURE__ */ new Map();
    for (const t of tokenize(p.description)) {
      if (resumeSet.has(t)) continue;
      if (groupMates(t).some((m) => resumeSet.has(m))) continue;
      descCounts.set(t, (descCounts.get(t) ?? 0) + 1);
    }
    const gaps = [...descCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([t]) => t);
    if (/staff|principal/.test(p.title.toLowerCase())) gaps.unshift("Staff/principal-level ask");
    const reasons = [];
    const postingYears = extractYears(`${p.title} ${p.description}`);
    if (postingYears !== null && (resumeYears === null || postingYears > resumeYears)) {
      reasons.push(
        resumeYears === null ? `Asks ${postingYears}+ years of experience \u2014 your resume doesn't state a years figure` : `Asks ${postingYears}+ years of experience, your resume shows ${resumeYears}`
      );
    }
    for (const skill of extractRequiredSkills(p.description, resumeSet)) {
      reasons.push(`Requires ${skill} \u2014 not shown in your resume`);
    }
    leads.push({
      company,
      title: p.title,
      location: effLoc,
      locationFlag: loc.flag,
      salaryText: parsePay(p.description),
      applyUrl: p.url,
      description: p.description.slice(0, 2e3),
      postedDate: p.postedDate,
      matchScore,
      // Provenance: an expanded match names the posting word it came
      // through, so a 'Developer (via Engineer)' strength can be
      // audited instead of trusted.
      strengths: matches.slice(0, 6).map((m) => m.exact ? cap(m.term) : `${cap(m.term)} (via ${cap(m.via)})`),
      gaps,
      reasons,
      needsReview,
      sourceType: p.source ?? "html"
    });
  }
  return { leads, rejectedNoMatch, rejectedLocation, reviewLocation, rejected };
}
function normalizeKey(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function jobDedupeKey(title, company) {
  return `${normalizeKey(title)}|${normalizeKey(company)}`;
}
function normalizeApplyUrl(rawUrl) {
  const raw = (rawUrl ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const path2 = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${path2}`;
  } catch {
    return raw.toLowerCase();
  }
}
function deriveTailoredFileName(company) {
  const clean = (company ?? "").trim().replace(/[\\/:*?"<>|]/g, "").trim();
  return clean ? `Eric_${clean}_Resume` : "Eric_Resume";
}
function newJobId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
async function autoAddLeadsToBoard(appStateCol, leads, resumeLabel) {
  const qualifying = leads.filter((l) => l.matchScore >= 60 && !l.needsReview);
  if (qualifying.length === 0 || !resumeLabel) return { added: 0, addedLeads: [] };
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await appStateCol.findOne({ _id: "jobboard" });
    if (!doc || !doc.state || !Array.isArray(doc.state.jobs)) return { added: 0, addedLeads: [] };
    const existing = new Set(
      doc.state.jobs.map((j) => jobDedupeKey(j.title ?? "", j.company ?? ""))
    );
    const existingUrls = new Set(
      doc.state.jobs.map((j) => normalizeApplyUrl(j.applyUrl ?? "")).filter((u) => u !== "")
    );
    const seen = /* @__PURE__ */ new Set();
    const seenUrls = /* @__PURE__ */ new Set();
    const fresh = qualifying.filter((l) => {
      const k = jobDedupeKey(l.title, l.company);
      if (existing.has(k) || seen.has(k)) return false;
      const u = normalizeApplyUrl(l.applyUrl ?? "");
      if (u !== "" && (existingUrls.has(u) || seenUrls.has(u))) return false;
      seen.add(k);
      if (u !== "") seenUrls.add(u);
      return true;
    });
    if (fresh.length === 0) return { added: 0, addedLeads: [] };
    const newJobs = fresh.map((l) => ({
      id: newJobId(),
      title: l.title,
      company: l.company,
      location: l.location,
      salaryText: l.salaryText || "",
      source: "Career Page",
      postedDate: l.postedDate || "",
      applyUrl: l.applyUrl,
      description: l.description || "",
      matchScore: l.matchScore,
      strengths: l.strengths ?? [],
      gaps: l.gaps ?? [],
      masterResumeName: resumeLabel,
      tailoredResumeText: "",
      tailoredFileName: deriveTailoredFileName(l.company),
      stageId: "new",
      notes: "Found via Finder.",
      activities: [],
      createdAt: now,
      updatedAt: now
    }));
    const nextState = { ...doc.state, jobs: [...doc.state.jobs, ...newJobs] };
    const res = await appStateCol.updateOne(
      { _id: "jobboard", updatedAt: doc.updatedAt },
      { $set: { state: nextState, updatedAt: /* @__PURE__ */ new Date() } },
      {}
    );
    if (res.matchedCount === 1) {
      return {
        added: newJobs.length,
        addedLeads: newJobs.map((j) => ({ title: j.title, company: j.company, matchScore: j.matchScore }))
      };
    }
  }
  return { added: 0, addedLeads: [] };
}
async function runFindJobs(deps, body, opts = {}) {
  const resumeText = typeof body.resumeText === "string" ? body.resumeText : "";
  const cursorRaw = Number(body.cursor ?? 0);
  const limitRaw = Number(body.limit ?? 15);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? Math.floor(cursorRaw) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : 15;
  const total = await deps.companiesCol.countDocuments();
  const slice = await deps.companiesCol.find({}).sort({ _id: 1 }).skip(cursor).limit(limit).toArray();
  const startedAt = Date.now();
  const leads = [];
  let postingsSeen = 0;
  let boardErrors = 0;
  let noBoard = 0;
  let unreachable = 0;
  let noListings = 0;
  let rejectedNoMatch = 0;
  let rejectedLocation = 0;
  let reviewLocation = 0;
  let rendered = 0;
  let renderAttempts = 0;
  let renderMs = 0;
  let searchHasListings = 0;
  let searchSearched = 0;
  let searchNoForm = 0;
  let searchSubmitFailed = 0;
  let searchNoResults = 0;
  let searchBoardRedirect = 0;
  let searchSkippedTime = 0;
  let searchMsTotal = 0;
  const renderBudget = { used: 0, max: MAX_RENDERS_PER_CALL };
  const renderDeadlineMs = startedAt + RENDER_WINDOW_MS;
  async function processCompany(company) {
    const result = await searchCompanyJobs(
      { name: company.name, website: company.website || "", careersUrl: company.careersUrl || "", isUSCompany: company.source !== "Manual" },
      resumeText,
      { renderPage: opts.renderPage ?? null, renderBudget, renderDeadlineMs }
    );
    postingsSeen += result.postingsSeen;
    if (!result.sourcePage) {
      noBoard += 1;
      if (result.fetchOk) noListings += 1;
      else unreachable += 1;
    }
    rejectedNoMatch += result.screened.rejectedNoMatch;
    rejectedLocation += result.screened.rejectedLocation;
    reviewLocation += result.screened.reviewLocation;
    if (result.renderUsed) rendered += 1;
    if (result.renderAttempted) renderAttempts += 1;
    renderMs += result.renderMs;
    if (result.searchOutcome) {
      searchMsTotal += result.searchMs;
      switch (result.searchOutcome) {
        case "has-listings":
          searchHasListings += 1;
          break;
        case "searched":
          searchSearched += 1;
          break;
        case "no-form":
          searchNoForm += 1;
          break;
        case "submit-failed":
          searchSubmitFailed += 1;
          break;
        case "no-results":
          searchNoResults += 1;
          break;
        case "board-redirect":
          searchBoardRedirect += 1;
          break;
        case "skipped-time":
          searchSkippedTime += 1;
          break;
      }
    }
    return result.leads;
  }
  let next = 0;
  const completed = /* @__PURE__ */ new Set();
  async function worker() {
    while (next < slice.length) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) return;
      const idx = next;
      next += 1;
      try {
        const found = await processCompany(slice[idx]);
        leads.push(...found);
      } catch {
        boardErrors += 1;
      }
      completed.add(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, () => worker()));
  let autoAdded = 0;
  let autoAddedLeads = [];
  if (body.autoAdd === true && typeof body.resumeLabel === "string" && body.resumeLabel.length > 0 && deps.appStateCol) {
    const added = await autoAddLeadsToBoard(deps.appStateCol, leads, body.resumeLabel);
    autoAdded = added.added;
    autoAddedLeads = added.addedLeads;
  }
  let prefix = 0;
  while (completed.has(prefix)) prefix += 1;
  const nextCursor = cursor + prefix;
  const done = nextCursor >= total;
  return {
    leads,
    checked: completed.size,
    totalCompanies: total,
    nextCursor: done ? null : nextCursor,
    done,
    autoAdded,
    autoAddedLeads,
    stats: {
      postingsSeen,
      boardErrors,
      noBoard,
      unreachable,
      noListings,
      rejectedNoMatch,
      rejectedLocation,
      reviewLocation,
      rendered,
      renderAttempts,
      renderMs,
      searchHasListings,
      searchSearched,
      searchNoForm,
      searchSubmitFailed,
      searchNoResults,
      searchBoardRedirect,
      searchSkippedTime,
      searchMs: searchMsTotal,
      autoAdded
    }
  };
}
async function handlerInner2(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  if (!authorized2(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const body = req.body ?? {};
  const result = await runFindJobs(
    {
      companiesCol: await getCompaniesCollection(),
      // The board write needs the state collection only when the
      // caller asked for server auto-add; the UI path never passes
      // autoAdd and never pays for the extra handle.
      appStateCol: body.autoAdd === true ? await getAppStateCollection() : void 0
    },
    { resumeText: body.resumeText, cursor: body.cursor, limit: body.limit, autoAdd: body.autoAdd, resumeLabel: body.resumeLabel },
    { renderPage: renderPageHtml }
  );
  res.status(200).json(result);
}
async function handler6(req, res) {
  try {
    await handlerInner2(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// api/test-company.ts
function stripInline(text) {
  return text.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
function buildMarkupOutline(html, pageUrl) {
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const anchors = [];
  const detailAnchors = [];
  let anchorCount = 0;
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let am;
  while ((am = anchorRe.exec(clean)) !== null) {
    anchorCount += 1;
    const openTag = am[0].slice(0, am[0].indexOf(">") + 1);
    const cls = (openTag.match(/class\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").slice(0, 80);
    const text = stripInline(am[2]).slice(0, 100);
    const href = am[1].trim();
    if (anchors.length < 15 && (/job|career|position|opening|apply|vacancy|role/i.test(href) || /job|career|position|opening/i.test(cls))) {
      anchors.push({ href: href.slice(0, 140), cls, text });
    }
    if (detailAnchors.length < 10) {
      try {
        const abs = new URL(href, pageUrl).href;
        if (isJobDetailUrl(abs)) detailAnchors.push({ href: abs.slice(0, 140), text });
      } catch {
      }
    }
  }
  const containers = [];
  const contRe = /<(div|section|article|ul|li|main|table)[^>]*(?:class|id)\s*=\s*["'][^"']*(?:job|listing|result|opening|vacancy|career|posting|position)[^"']*["'][^>]*>/gi;
  let cm;
  while ((cm = contRe.exec(clean)) !== null && containers.length < 20) {
    const tag = cm[0];
    containers.push({
      tag: (tag.match(/^<(\w+)/)?.[1] ?? "").toLowerCase(),
      cls: (tag.match(/class\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").slice(0, 80),
      id: (tag.match(/id\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").slice(0, 80)
    });
  }
  const bodyText = stripInline(clean);
  const countLines = [];
  for (const re of [
    /[\d,]+\s+(jobs?|results?|openings?|positions?|roles?)\b/gi,
    /results?\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+[\d,]+/gi,
    /[\d,]+\s*[–—-]\s+[\d,]+\s+of\s+[\d,]+\s+(jobs?|results?|openings?|positions?|roles?)\b/gi
  ]) {
    for (const m of bodyText.matchAll(re)) {
      if (countLines.length >= 3) break;
      const v = m[0].replace(/\s+/g, " ").trim().slice(0, 120);
      if (v && !countLines.includes(v)) countLines.push(v);
    }
    if (countLines.length >= 3) break;
  }
  let scriptHint = "";
  const hintAt = html.search(/"jobs"\s*:|JobPosting|job-results|__NEXT_DATA__/);
  if (hintAt >= 0) {
    scriptHint = html.slice(Math.max(0, hintAt - 100), hintAt + 100).replace(/\s+/g, " ").trim().slice(0, 200);
  }
  let parsed = [];
  try {
    parsed = parseCareersPage(html, pageUrl);
  } catch {
    parsed = [];
  }
  return {
    htmlBytes: html.length,
    anchorCount,
    detailLinkCount: detailAnchors.length,
    parsedPostings: parsed.length,
    parsedTitles: parsed.slice(0, 5).map((p) => p.title),
    anchors,
    detailAnchors,
    containers,
    countLines,
    hasJsonLd: /"@type"\s*:\s*"JobPosting"/i.test(html),
    hasNextData: /__NEXT_DATA__/.test(html),
    scriptHint
  };
}
async function handler7(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    if (!authorized2(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body ?? {};
    const c = typeof body.company === "object" && body.company !== null ? body.company : {};
    const name = String(c.name ?? "").trim();
    const website = String(c.website ?? "").trim();
    const careersUrl = String(c.careersUrl ?? "").trim();
    const resumeText = typeof body.resumeText === "string" ? body.resumeText : "";
    if (!name || !website && !careersUrl) {
      res.status(400).json({ error: "A company name and a website or careers link are required." });
      return;
    }
    if (body.probe === true) {
      const target = careersUrl || website;
      const rendered = await renderPageHtml(target, portalSearchTerm(resumeText));
      if (!rendered) {
        res.status(200).json({
          company: name,
          probe: true,
          renderedUrl: "",
          searchOutcome: null,
          searchMs: 0,
          renderError: "render-null",
          renderTextSample: "",
          markup: null
        });
        return;
      }
      res.status(200).json({
        company: name,
        probe: true,
        sourcePage: target,
        renderedUrl: rendered.renderedUrl,
        searchOutcome: rendered.searchOutcome,
        searchMs: rendered.searchMs,
        renderError: rendered.renderError ?? null,
        searchScan: rendered.searchScan ?? null,
        renderTextSample: rendered.html ? sampleRenderedText(rendered.html) : "",
        markup: rendered.html ? buildMarkupOutline(rendered.html, rendered.renderedUrl || target) : null
      });
      return;
    }
    const result = await searchCompanyJobs(
      {
        name,
        website,
        careersUrl,
        // Read-only roster lookup (see the header): a roster company
        // is a U.S. company by construction. Best-effort — a DB
        // failure leaves isUSCompany false rather than failing the
        // test, exactly the old behavior.
        isUSCompany: await (async () => {
          try {
            const companiesCol = await getCompaniesCollection();
            return await resolveIsUSCompany(companiesCol, { name, website, careersUrl });
          } catch {
            return false;
          }
        })()
      },
      resumeText,
      {
        renderPage: renderPageHtml,
        // Two renders per test: a no-form or failed first render retries
        // the next-best target instead of spending the test on the
        // wrong page.
        renderBudget: { used: 0, max: 2 }
      }
    );
    res.status(200).json({
      company: name,
      sourcePage: result.sourcePage,
      triedUrls: result.triedUrls,
      postingsSeen: result.postingsSeen,
      fetchOk: result.fetchOk,
      renderUsed: result.renderUsed,
      renderMs: result.renderMs,
      // True even when the render failed or found nothing — the honest
      // fire counter (renderMs can be 0 for a fast render death).
      renderAttempted: result.renderAttempted,
      renderError: result.renderError ?? null,
      // What the portal search step did, so a zero-listing render can
      // be told apart from a render that never searched.
      searchOutcome: result.searchOutcome,
      // Why the search found no box — the scan summary from the
      // rendered page. Null unless the search ended no-form.
      searchScan: result.searchScan ?? null,
      searchMs: result.searchMs,
      renderedUrl: result.renderedUrl,
      renderTextSample: result.renderTextSample,
      // Per-attempt render telemetry + the sorted target list, so a
      // zero-listing canary can say whether the retry fired, what it
      // tried, and whether a portal ever made the target list.
      renderAttempts: result.renderAttempts ?? [],
      renderTargets: result.renderTargets ?? [],
      screened: result.screened,
      leads: result.leads
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    res.status(500).json({ error: msg });
  }
}

// cloud-run/server/server.mjs
process.env.JOBBOARD_NO_RENDER = "1";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = Number(process.env.PORT ?? 8080);
var MAX_BODY_BYTES = 10 * 1024 * 1024;
var ROUTES = /* @__PURE__ */ new Map([
  ["/api/state", handler],
  ["/api/companies", handler2],
  ["/api/companies/import", handler3],
  ["/api/companies/migrate", handler4],
  ["/api/find-companies", handler5],
  ["/api/find-jobs", handler6],
  ["/api/test-company", handler7]
]);
function findStaticRoot() {
  const candidates = [
    process.env.STATIC_DIR,
    path.resolve(__dirname, "..", "..", "..", "dist"),
    path.resolve(process.cwd(), "dist")
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fsSync.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}
var STATIC_ROOT = findStaticRoot();
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
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
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    nodeRes.end(head ? void 0 : data);
    return 200;
  } catch {
    return null;
  }
}
async function serveStatic(nodeReq, nodeRes, urlPath) {
  const head = nodeReq.method === "HEAD";
  if (urlPath === "/" || urlPath === "") {
    const status2 = await serveFile(nodeRes, path.join(STATIC_ROOT, "index.html"), { head });
    return status2 ?? 500;
  }
  const filePath = staticPathFor(urlPath);
  if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const status2 = await serveFile(nodeRes, filePath, { head });
        if (status2 !== null) return status2;
      }
    } catch {
    }
  }
  const status = await serveFile(nodeRes, path.join(STATIC_ROOT, "index.html"), { head });
  return status ?? 500;
}
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
    body
  };
}
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
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(payload),
            "cache-control": "no-store"
          });
          nodeRes.end(payload);
        }
      };
    }
  };
}
async function readBody(nodeReq) {
  const contentType = String(nodeReq.headers["content-type"] ?? "");
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeReq) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return void 0;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!contentType.includes("application/json")) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON body");
    err.status = 400;
    throw err;
  }
}
function sendJson(nodeRes, code, body) {
  const payload = JSON.stringify(body);
  nodeRes.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  nodeRes.end(payload);
}
async function handleApi(nodeReq, nodeRes, url, pathname) {
  const handler8 = ROUTES.get(pathname);
  if (!handler8) {
    sendJson(nodeRes, 404, { error: "not found" });
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
  let statusCode = 200;
  const origWriteHead = nodeRes.writeHead.bind(nodeRes);
  nodeRes.writeHead = (code, ...rest) => {
    statusCode = code;
    return origWriteHead(code, ...rest);
  };
  try {
    await handler8(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    if (!nodeRes.writableEnded) sendJson(nodeRes, 500, { error: msg });
    statusCode = 500;
  }
  return statusCode;
}
var server = http.createServer(async (nodeReq, nodeRes) => {
  const started = Date.now();
  const method = nodeReq.method ?? "GET";
  let url;
  try {
    url = new URL(nodeReq.url ?? "/", "http://localhost");
  } catch {
    sendJson(nodeRes, 400, { error: "bad request" });
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  let status = 500;
  try {
    if (method === "OPTIONS") {
      nodeRes.writeHead(204, {
        allow: "GET, HEAD, POST, PUT, OPTIONS",
        "content-length": "0"
      });
      nodeRes.end();
      status = 204;
    } else if (pathname === "/healthz") {
      sendJson(nodeRes, 200, { ok: true, render: "disabled" });
      status = 200;
    } else if (pathname.startsWith("/api/")) {
      if (method === "HEAD") {
        nodeRes.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        nodeRes.end();
        status = 405;
      } else {
        status = await handleApi(nodeReq, nodeRes, url, pathname);
      }
    } else if (method === "GET" || method === "HEAD") {
      status = await serveStatic(nodeReq, nodeRes, pathname);
    } else {
      sendJson(nodeRes, 405, { error: "method not allowed" });
      status = 405;
    }
  } catch (e) {
    if (!nodeRes.writableEnded) {
      sendJson(nodeRes, 500, { error: e instanceof Error ? e.message : "failed" });
    }
    status = 500;
  }
  console.log(`${method} ${pathname} -> ${status} ${Date.now() - started}ms`);
});
server.listen(PORT, () => {
  console.log(`jobboard service listening on :${PORT} (static: ${STATIC_ROOT}, render: disabled)`);
});
server.on("error", (e) => {
  console.error("server error:", e);
  process.exit(1);
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
