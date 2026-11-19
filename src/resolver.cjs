// resolver.cjs — ATS resolver (pure function, no network).
// Input: a company's domain + the raw HTML of its careers page(s) + the
// final URL after redirects. Output: { ats, slug, host, site, evidenceUrl }
// or { ats: 'unresolved' }.
// Rule (Claude/Genspark): accept a board ONLY if the company's own domain
// links to it — that is the "own careers page" proof and prevents slug
// collisions. Tokens appear in script src / iframe src even on JS-rendered
// pages, so raw HTML is enough; no browser needed.
'use strict';

// [host token, ats, slug extractor(html, finalUrl)]
// Slug extraction reads the token's URL out of the HTML; when the HTML only
// proves the ATS family (e.g. a Workday tenant link), the tenant/site come
// from the URL itself.
const ATS_PATTERNS = [
  {
    ats: 'greenhouse',
    tokens: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards-api.greenhouse.io'],
    slugFrom: (html, url) => {
      // Greenhouse embed widget: boards.greenhouse.io/embed/job_board/js?for=<token>
      // The board token is the for= param — the first path segment is "embed",
      // which is NEVER a board token (ingest pilot: slug "embed" 404s on
      // boards-api and both pilot companies errored with 0 jobs).
      const embed = html.match(/boards\.greenhouse\.io\/embed\/job_board[^"'\s]*[?&]for=([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/boards\.greenhouse\.io\/embed\/job_board[^"'\s]*[?&]for=([a-z0-9][a-z0-9_-]*)/i);
      if (embed) return embed[1].toLowerCase();
      const m = html.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/job-boards\.greenhouse\.io\/([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/boards\.greenhouse\.io\/([a-z0-9][a-z0-9_-]*)/i);
      if (!m) return null;
      const slug = m[1].toLowerCase();
      return slug === 'embed' ? null : slug;
    },
  },
  {
    ats: 'lever',
    tokens: ['jobs.lever.co', 'api.lever.co', 'api.eu.lever.co'],
    slugFrom: (html, url) => {
      const m = html.match(/jobs\.lever\.co\/([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/jobs\.lever\.co\/([a-z0-9][a-z0-9_-]*)/i);
      return m ? m[1].toLowerCase() : null;
    },
  },
  {
    ats: 'ashby',
    tokens: ['jobs.ashbyhq.com', 'api.ashbyhq.com'],
    slugFrom: (html, url) => {
      const m = html.match(/jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]*)/i);
      return m ? m[1].toLowerCase() : null;
    },
  },
  {
    ats: 'workday',
    tokens: ['myworkdayjobs.com'],
    slugFrom: (html, url) => {
      // {tenant}.wd{N}.myworkdayjobs.com/{locale}/{site} — the site is the
      // LAST path segment; the locale (en-US) is not the site. The wd
      // number varies per tenant (wd1/wd2/wd5...) and the API host needs
      // it, so capture it — never default to wd5.
      const m = url.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-z0-9_-]+)/i)
        || html.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-z0-9_-]+)/i);
      if (!m) return null;
      const tenant = m[1].toLowerCase();
      return { tenant, site: m[3], host: `${tenant}.${m[2].toLowerCase()}.myworkdayjobs.com` };
    },
  },
  {
    ats: 'smartrecruiters',
    tokens: ['careers.smartrecruiters.com', 'api.smartrecruiters.com'],
    slugFrom: (html, url) => {
      const m = html.match(/careers\.smartrecruiters\.com\/([a-z0-9][a-z0-9_-]*)/i)
        || url.match(/careers\.smartrecruiters\.com\/([a-z0-9][a-z0-9_-]*)/i)
        || html.match(/api\.smartrecruiters\.com\/v1\/companies\/([a-z0-9][a-z0-9_-]*)/i);
      return m ? m[1] : null;
    },
  },
  {
    ats: 'icims',
    tokens: ['icims.com'],
    slugFrom: (html, url) => {
      // Preferred: careers-<slug>.icims.com
      const m = url.match(/careers-([a-z0-9-]+)\.icims\.com/i)
        || html.match(/careers-([a-z0-9-]+)\.icims\.com/i);
      if (m) return m[1].toLowerCase();
      // Bare-tenant boards: <slug>.icims.com (e.g.
      // faculty-saintmarysuniversity.icims.com). 68 resolved entries were
      // detected-but-not-crawlable because only the careers- form matched.
      // Exclude the vendor's own subdomains so a marketing/API link never
      // yields a slug; the (?![a-z0-9.-]) guard stops x.icims.com.evil.com
      // from matching as slug "x".
      const b = url.match(/([a-z0-9-]+)\.icims\.com(?![a-z0-9.-])/i)
        || html.match(/([a-z0-9-]+)\.icims\.com(?![a-z0-9.-])/i);
      if (!b) return null;
      const slug = b[1].toLowerCase();
      return ['www', 'api', 'app', 'support', 'careers'].includes(slug) ? null : slug;
    },
  },
  {
    ats: 'taleo',
    tokens: ['taleo.net'],
    slugFrom: (html, url) => {
      const m = url.match(/([a-z0-9-]+)\.taleo\.net/i)
        || html.match(/([a-z0-9-]+)\.taleo\.net/i);
      return m ? m[1].toLowerCase() : null;
    },
  },
  // Known families with no public JSON feed — resolved for reporting only,
  // never crawled by the JSON fetchers (Playwright tier later, or parked).
  { ats: 'successfactors', tokens: ['successfactors.com', 'successfactors.eu'], slugFrom: () => null },
  { ats: 'phenom', tokens: ['phenompeople.com'], slugFrom: () => null },
  { ats: 'eightfold', tokens: ['eightfold.ai'], slugFrom: () => null },
  { ats: 'jobvite', tokens: ['jobvite.com'], slugFrom: () => null },
  { ats: 'workable', tokens: ['apply.workable.com'], slugFrom: (html) => {
    const m = html.match(/apply\.workable\.com\/api\/v1\/widget\/accounts\/([a-z0-9][a-z0-9_-]*)/i);
    return m ? m[1] : null;
  } },
  { ats: 'recruitee', tokens: ['recruitee.com'], slugFrom: (html) => {
    const m = html.match(/([a-z0-9-]+)\.recruitee\.com/i);
    return m ? m[1].toLowerCase() : null;
  } },
  { ats: 'personio', tokens: ['jobs.personio.de', 'personio.de'], slugFrom: (html) => {
    const m = html.match(/([a-z0-9-]+)\.jobs\.personio\.de/i);
    return m ? m[1].toLowerCase() : null;
  } },
  { ats: 'teamtailor', tokens: ['teamtailor.com'], slugFrom: () => null },
  { ats: 'rippling', tokens: ['ats.rippling.com'], slugFrom: (html) => {
    const m = html.match(/ats\.rippling\.com\/api\/v2\/board\/([a-z0-9][a-z0-9_-]*)/i);
    return m ? m[1] : null;
  } },
  // --- Second wave (2026-11-19, coverage investigation + new-ats-families.md) ---
  // Crawlable families have a public no-auth feed (fetchers are a separate
  // track); reporting-only families return null from slugFrom per the
  // existing convention, so nothing tries to crawl them. Their slug regexes
  // are recorded in new-ats-families.md for a future HTML tier.
  // NEOGOV / GovernmentJobs — reporting-only (API key-gated; SSR HTML board).
  // SchoolJobs is a NEOGOV brand on the same platform; checked first so a
  // schooljobs.com board resolves as schooljobs, not neogov.
  { ats: 'schooljobs', tokens: ['schooljobs.com'], slugFrom: () => null },
  { ats: 'neogov', tokens: ['governmentjobs.com', 'neogov.com'], slugFrom: () => null },
  // JobScore — feed YES: GET careers.jobscore.com/jobs/<slug>/feed.json (no auth).
  { ats: 'jobscore', tokens: ['careers.jobscore.com', 'jobscore.com'], slugFrom: (html, url) => {
    const m = html.match(/careers\.jobscore\.com\/careers\/([a-z0-9][a-z0-9_-]*)/i)
      || url.match(/careers\.jobscore\.com\/careers\/([a-z0-9][a-z0-9_-]*)/i);
    return m ? m[1].toLowerCase() : null;
  } },
  // PageUp — reporting-only (REST API OAuth-gated; Clinch company_id not derivable).
  { ats: 'pageup', tokens: ['careers.pageuppeople.com', 'pageuppeople.com'], slugFrom: () => null },
  // ADP Workforce Now — reporting-only (public feed endpoint UNVERIFIED;
  // official API is OAuth2 + mTLS key-gated). Do not confuse with myjobs.
  { ats: 'adp-workforcenow', tokens: ['workforcenow.adp.com'], slugFrom: () => null },
  // ADP myjobs.adp.com — feed YES (no key, two calls): career-site call
  // returns orgoid, then job-requisitions with the orgoid header.
  { ats: 'adp-myjobs', tokens: ['myjobs.adp.com'], slugFrom: (html, url) => {
    const m = html.match(/myjobs\.adp\.com\/([a-z0-9][a-z0-9_-]*)/i)
      || url.match(/myjobs\.adp\.com\/([a-z0-9][a-z0-9_-]*)/i);
    return m ? m[1].toLowerCase() : null;
  } },
  // Oracle HCM (Recruiting Cloud) — feed YES: hcmRestApi
  // recruitingCEJobRequisitions (no auth). Token is the CandidateExperience
  // path only — bare oraclecloud.com also hosts non-careers Oracle pages.
  // NOTE: tokens are matched against LOWERCASED html/url (see resolveAts),
  // so this token must stay lowercase.
  // Returns an object like Workday: {tenant, site, host}.
  { ats: 'oracle', tokens: ['hcmui/candidateexperience'], slugFrom: (html, url) => {
    const m = url.match(/([a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/(CX(?:_\d+)?)/i)
      || html.match(/([a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/(CX(?:_\d+)?)/i);
    if (!m) return null;
    return { tenant: m[1].toLowerCase(), site: m[2], host: m[1].toLowerCase() };
  } },
  // PeopleMatter (Fourth) — reporting-only (Open API partner-gated).
  { ats: 'peoplematter', tokens: ['my.peoplematter.com', 'peoplematter.at'], slugFrom: () => null },
  // BambooHR — feed YES: GET <slug>.bamboohr.com/careers/list (no auth);
  // detail at /careers/<id>/detail (the list has no date). A non-existent
  // tenant redirects to bamboohr.com and answers 200 with HTML — the
  // fetcher must verify the body parses as JSON.
  { ats: 'bamboohr', tokens: ['bamboohr.com'], slugFrom: (html, url) => {
    const m = html.match(/([a-z0-9][a-z0-9_-]*)\.bamboohr\.com\/careers/i)
      || url.match(/([a-z0-9][a-z0-9_-]*)\.bamboohr\.com\/careers/i);
    return m ? m[1].toLowerCase() : null;
  } },
  // JazzHR — feed YES, as XML (not JSON): app.jazz.co/feeds/export/jobs/<slug>
  // (no auth, generated once/day, rate-limited). The v1 REST API needs a key.
  { ats: 'jazzhr', tokens: ['applytojob.com', 'app.jazz.co'], slugFrom: (html, url) => {
    const m = html.match(/([a-z0-9][a-z0-9_-]*)\.applytojob\.com/i)
      || url.match(/([a-z0-9][a-z0-9_-]*)\.applytojob\.com/i);
    return m ? m[1].toLowerCase() : null;
  } },
  // Paylocity — reporting-only (Integration API partner-gated). Board HTML
  // embeds a window.pageData object with every job — HTML-tier parseable.
  { ats: 'paylocity', tokens: ['recruiting.paylocity.com'], slugFrom: () => null },
  // UKG Pro Recruiting — reporting-only (APIs OAuth-gated). Tenant capture
  // pattern is UNVERIFIED against a live board URL — confirm before shipping
  // a slug. UKG Ready is a separate product; do not merge.
  { ats: 'ukg', tokens: ['ultipro.com', 'recruiting.ultipro.com'], slugFrom: () => null },
  // Breezy — feed YES: GET <slug>.breezy.hr/json (no auth, bare array, no
  // description — detail pages carry it). The v3 REST API needs a token.
  { ats: 'breezy', tokens: ['breezy.hr'], slugFrom: (html, url) => {
    const m = html.match(/([a-z0-9][a-z0-9_-]*)\.breezy\.hr/i)
      || url.match(/([a-z0-9][a-z0-9_-]*)\.breezy\.hr/i);
    return m ? m[1].toLowerCase() : null;
  } },
  // Fountain — reporting-only (no public list endpoint; the company slug
  // alone cannot enumerate openings; apply pages behind Cloudflare
  // Turnstile). Token requires /apply/ so the vendor marketing site
  // (fountain.com) never resolves as a board.
  { ats: 'fountain', tokens: ['fountain.com/apply/'], slugFrom: () => null },
  // Hireology — reporting-only (API credential-gated).
  { ats: 'hireology', tokens: ['careers.hireology.com'], slugFrom: () => null },
];

function resolveAts(domain, html, finalUrl) {
  const body = (html || '').toLowerCase();
  const url = (finalUrl || '').toLowerCase();
  for (const p of ATS_PATTERNS) {
    const hit = p.tokens.some((t) => body.includes(t) || url.includes(t));
    if (!hit) continue;
    const slug = p.slugFrom(html || '', finalUrl || '');
    const result = { ats: p.ats, evidenceUrl: finalUrl || `https://${domain}/careers` };
    if (typeof slug === 'string') {
      result.slug = slug;
    } else if (slug && typeof slug === 'object') {
      result.tenant = slug.tenant;
      result.site = slug.site;
      result.slug = `${slug.tenant}/${slug.site}`;
      if (slug.host) result.host = slug.host;
    }
    // A detected ATS family with no extractable slug is still a resolution
    // (it tells the pilot where the volume is), but it is NOT crawlable
    // until the slug/tenant is confirmed against the live ATS API.
    result.crawlable = Boolean(result.slug);
    return result;
  }
  return { ats: 'unresolved', crawlable: false, evidenceUrl: finalUrl || `https://${domain}/careers` };
}

module.exports = { resolveAts, ATS_TOKENS: [...new Set(ATS_PATTERNS.flatMap((p) => p.tokens))] };
