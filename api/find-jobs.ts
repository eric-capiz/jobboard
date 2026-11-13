/* Finder job search — Vercel serverless function.
 *
 * Searches companies' OWN careers boards for live remote postings
 * matched to the resume the user selected — whatever its field. It never
 * touches aggregators, never takes a URL from the client (the server
 * pages its own companies collection — no seed fallback exists), and
 * by default never writes anything: leads are returned to the app,
 * which adds 60%+ matches to the Pipeline and leaves the rest as near
 * misses. (Opt-in server auto-add, for headless callers such as the
 * sweep workers: see autoAddLeadsToBoard — the caller passes
 * autoAdd: true and the function appends qualifying leads to the
 * board itself.)
 *
 * Chunked + idempotent: the server pages the companies collection by
 * insertion order with a cursor the client passes back; the function
 * processes that slice and returns the next cursor. A timed-out chunk is
 * simply retried. By default no state is written server-side, so a
 * retry can never duplicate anything; with autoAdd on, a retry is
 * still safe — the append dedupes by title+company against the board
 * and is guarded by the state doc's updatedAt.
 *
 * Auth mirrors /api/state: the x-sync-key header must match SYNC_KEY.
 */

import {
  authorized,
  getAppStateCollection,
  getCompaniesCollection,
  isBoardUrl,
  type CompanyDoc,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';
import { renderPageHtml, type RenderPageFn, type RenderPageResult } from './render-page.js';
import type { PortalSearchOutcome, SearchScanSummary } from './render-search.js';
import type { Collection } from 'mongodb';

const FETCH_TIMEOUT_MS = 6000;
const SOFT_DEADLINE_MS = 50000;
const CONCURRENCY = 5;
const MAX_LIMIT = 25;
/** At most 2 renders per chunk invocation: a render is slow (cold
 *  ~30s, warm ~5-10s), and one slow company must never eat a chunk.
 *  The sweep client re-calls with a fresh budget for the next chunk. */
const MAX_RENDERS_PER_CALL = 2;
/** Renders may only START in the first 30s of a chunk: a render
 *  started later could still be running when maxDuration (60s) hits. */
const RENDER_WINDOW_MS = 30000;

/* ------------------------------------------------------------------ */
/* Page-fetch helpers                                                    */
/* ------------------------------------------------------------------ */

interface Posting {
  title: string;
  location: string;
  url: string;
  description: string;
  postedDate: string;
  /** Which reader produced this posting, stamped when sources are
   *  unioned: 'html' (page listings), 'jazzhr' / 'isolved' /
   *  'greenhouse' (embedded widget/iframe/embed), 'jsonld' (structured
   *  data on the same page). Provenance for the lead card. */
  source?: string;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'Mozilla/5.0 (JobBoard Finder)', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function stripTags(text: string): string {
  // Entities decoded BEFORE tags are stripped: board descriptions
  // often carry double-escaped markup (&amp;nbsp;, &lt;li&gt;), and
  // decoding after stripping leaves junk tokens (nbsp, lt, gt, li)
  // in the text — which then pollute the gaps list.
  return text
    .replace(/<script.*?<\/script>/gis, ' ')
    .replace(/<style.*?<\/style>/gis, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Numeric character references — the named-entity decodes above
    // left these raw, so TTEC's TalentBrew titles arrived as
    // 'Fran&#xE7;ais' and read as garbage in lead cards and in the
    // rejected-title telemetry (2026-11-12 canary). decodeNumericEntity
    // runs after the &amp; decode, so a double-escaped &#233; is caught
    // too. An out-of-range code point decodes to '' rather than
    // throwing (String.fromCodePoint throws past 0x10FFFF).
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => decodeNumericEntity(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => decodeNumericEntity(parseInt(dec, 10)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeNumericEntity(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** The job-list widget embedded IN a business careers page: some
 *  companies render their own page's job list through a JazzHR widget
 *  script. The widget is part of the page — the jobs it carries are
 *  the jobs displayed on that page, and their apply links may point at
 *  the board. Only an embed found on the business page itself is ever
 *  read; no board list page, board API, or board link is ever fetched
 *  as a source. */
function jazzhrWidgetSlug(pageHtml: string): string | null {
  const m = pageHtml.match(/app\.jazz\.co\/widgets\/basic\/create\/([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}

/** The Greenhouse job board embed script on a business careers page
 *  (boards.greenhouse.io/embed/job_board/js?for=<slug>): the page loads
 *  this script to display its own jobs, so the embed's data is the
 *  page's own display — same rule as the JazzHR widget and the iSolved
 *  iframe. Only an embed found on the business page itself is read. */
function greenhouseEmbedSlug(pageHtml: string): string | null {
  const m = pageHtml.match(/boards\.greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9\-_]+)/);
  return m ? m[1] : null;
}

/** Parse a Greenhouse board's jobs JSON (the embed's own data source)
 *  into postings. Apply URLs come through as given — for embedded
 *  boards they usually point back at the business site itself. */
export function parseGreenhouseJobs(jsonText: string): Posting[] {
  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return (data.jobs ?? []).map((j: any) => {
    const d = new Date(j.created_at ?? '');
    return {
      title: j.title ?? '',
      location: j.location?.name ?? '',
      url: j.absolute_url ?? '',
      description: stripTags(j.content ?? ''),
      postedDate: Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10),
    };
  });
}

/** The job-list iframe embedded IN a business careers page: some
 *  companies display their own page's job list through an iSolved Hire
 *  iframe. Like the JazzHR widget, the iframe is part of the page — the
 *  jobs it carries are the jobs displayed on that page, and their apply
 *  links may point at the board. Only an iframe found on the business
 *  page itself is ever read. */
function isolvedIframeUrl(pageHtml: string): string | null {
  const m = pageHtml.match(/<iframe[^>]*src="([^"]*isolvedhire\.com[^"]*)"/i);
  return m ? m[1] : null;
}

/** Parse an iSolved Hire iframe job list: each job is a link wrapping a
 *  job-info div with an h4 title and a listing-details list whose first
 *  item is the location. When the title itself says (Remote), the role
 *  is remote — the location line underneath is the office, and the
 *  remote-only verdict must see the title's Remote, not the office. */
export function parseIsolvedIframe(html: string, pageUrl: string): Posting[] {
  const postings: Posting[] = [];
  const re = /<a\s+href="([^"]+)"[^>]*>\s*<div class="job-info">\s*<h4>([^<]+)<\/h4>\s*<ul class="listing-details">\s*<li>([^<]*)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const title = m[2].trim();
    const liLoc = m[3].trim();
    if (!title) continue;
    let url: string | null = null;
    try {
      url = new URL(m[1], pageUrl).href;
    } catch {
      url = null;
    }
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) continue;
    postings.push({
      title,
      location: /\(remote\)|\bremote\b/i.test(title) ? 'Remote' : liLoc,
      url,
      description: '',
      postedDate: '',
    });
  }
  return postings;
}

/** Parse a JazzHR basic widget script: each job is a resumator-job block
 *  with a title div, a "Location: X" span, a "Department: Y" span, and a
 *  + View details link to the apply page. The widget renders jobs
 *  client-side, but the listings themselves are IN the script text, so
 *  fetching the widget URL is enough — no browser needed. The job div id
 *  carries its posting date (job_YYYYMMDDHHMMSS_...). */
export function parseJazzhrWidget(js: string): Posting[] {
  const postings: Posting[] = [];
  const blocks = js.split('<div id="resumator-job-job_');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const dateMatch = b.match(/^(\d{4})(\d{2})(\d{2})/);
    const titleMatch = b.match(/resumator-job-title[^>]*>([^<]+)<\/div>/);
    const locMatch = b.match(/resumator-job-location[^>]*>Location:\s*<\/span>\s*([^<]+)/);
    const deptMatch = b.match(/resumator-job-department[^>]*>Department:\s*<\/span>\s*([^<]+)/);
    const linkMatch = b.match(/resumator-job-link[^>]*href="([^"]+)"/);
    const title = (titleMatch?.[1] ?? '').trim();
    if (!title || !linkMatch) continue;
    postings.push({
      title,
      location: (locMatch?.[1] ?? '').trim(),
      url: linkMatch[1].split('?')[0],
      description: (deptMatch?.[1] ?? '').trim(),
      postedDate: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '',
    });
  }
  return postings;
}

/* ------------------------------------------------------------------ */
/* Filters + resume scoring                                            */
/* ------------------------------------------------------------------ */

const EXCLUDED_PLACES = ['canada', 'mexico', 'brazil', 'uk', 'united kingdom', 'london', 'europe', 'emea', 'apac', 'singapore', 'india', 'australia', 'germany', 'france', 'spain', 'poland', 'portugal', 'netherlands', 'ireland', 'philippines', 'colombia', 'argentina', 'chile', 'japan', 'korea', 'china', 'israel', 'kenya', 'nigeria', 'south africa', 'new zealand'];

/* ------------------------------------------------------------------ */
/* Resume-driven matching — no hardcoded field                         */
/* ------------------------------------------------------------------ */

// The match vocabulary comes from the resume the user selected, not
// from a fixed list: a frontend resume matches frontend roles, a
// support resume matches support roles, and so on. Field words
// (support, customer, nurse, analyst, engineer) are NEVER stopwords —
// only function words and generic resume/posting boilerplate are.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'may',
  'might', 'do', 'does', 'did', 'we', 'you', 'they', 'he', 'she', 'it',
  'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their',
  'his', 'her', 'not', 'no', 'if', 'but', 'so', 'than', 'then', 'when',
  'while', 'who', 'whom', 'what', 'which', 'how', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own',
  'same', 'too', 'very', 'just', 'also', 'over', 'under', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'up',
  'down', 'out', 'off', 'again', 'further', 'once', 'here', 'there',
  'where', 'why', 'because', 'until', 'per', 'via', 'am',
  'experience', 'experiences', 'skills', 'skill', 'responsibilities',
  'responsible', 'duties', 'education', 'work', 'worked', 'working',
  'years', 'year', 'strong', 'excellent', 'passionate', 'proven',
  'ability', 'including', 'include', 'includes', 'team', 'teams', 'role',
  'roles', 'position', 'positions', 'company', 'companies', 'join',
  'joining', 'looking', 'seek', 'seeking', 'need', 'needs', 'required',
  'requirements', 'preferred', 'bonus', 'plus', 'etc',
]);

/** Lowercase word tokens, minus stopwords, minus pure numbers and
 *  single letters. Applied identically to resumes, titles, and posting
 *  text, so a term matches only when both sides actually use the word.
 *  Plurals are stemmed (developers → developer, systems → system) so
 *  a plural on one side still matches the singular on the other — the
 *  stem runs BEFORE the stopword filter, so a plural of a stopword
 *  (teams → team) is still filtered. Words ending in 'ss'/'us' and
 *  words of 3 letters or fewer are never stemmed. */
function tokenize(text: string): string[] {
  // "Front End" and "Frontend" are the same skill — normalize before
  // splitting so a "Front End Developer" posting matches a "Frontend"
  // resume (and likewise Back End / Backend). Applied to resumes and
  // postings alike, so matching stays symmetric.
  const normalized = text
    .toLowerCase()
    .replace(/\bfront[\s\-]+end\b/g, 'frontend')
    .replace(/\bback[\s\-]+end\b/g, 'backend');
  return (normalized.match(/[a-z0-9]+/g) ?? [])
    .map((t) =>
      t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')
        ? t.slice(0, -1)
        : t,
    )
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

/** The resume's signature terms: every token it uses, most frequent
 *  first (ties broken alphabetically for determinism). A term only
 *  counts when it actually appears in the resume text — nothing is
 *  credited that the resume doesn't claim. There used to be a top-40
 *  cap; it starved customer-service matching, because a CS resume
 *  repeats employer words (verizon, drug, alorica) while its function
 *  words appear once (support, representative, center) — the cap kept
 *  the noise and dropped the vocabulary real job titles use, so a
 *  'Customer Support Representative' title could only ever match one
 *  term and stuck at 55, below auto-add. Frequency still orders the
 *  list; the cap is gone. */
export function extractResumeTerms(resumeText: string): string[] {
  const counts = new Map<string, number>();
  for (const t of tokenize(resumeText)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([t]) => t);
}

/* Synonym groups for matching — approved aliases only. Two words are
 *  deliberately NOT groups: 'development' (it matches 'Business
 *  Development' roles that are not developer roles) and 'software'
 *  ('Software Sales' is not a developer role, and 'Software Engineer'
 *  already matches through the engineer → developer alias). Groups
 *  expand MATCHING only — the resume text itself is never changed.
 *  One posting word credits at most one resume term (see
 *  matchResumeTerms), so a group can no longer inflate a score: the
 *  word 'member' credits the member term only, never customer + client
 *  + member together. That is what makes the customer-service groups
 *  safe: 'customer'/'client'/'member' are the same function under
 *  different employers' wording, and 'service'/'support'/'help' and
 *  'agent'/'representative'/'specialist' likewise — without them a
 *  'Client Support Specialist' title matches a single resume word and
 *  never reaches auto-add, which is exactly the failure the Nov 10 CS
 *  sweep exposed. 'client' used to be deliberately excluded (it matches
 *  'Client Success' roles); for a CS resume those ARE the roles, and
 *  for other resumes the group is inert unless the resume claims one
 *  of its words. */
const SYNONYM_GROUPS: string[][] = [
  ['developer', 'engineer', 'programmer'],
  ['frontend', 'web', 'ui'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['react', 'reactjs'],
  ['service', 'support', 'help'],
  ['customer', 'client', 'member'],
  ['agent', 'representative', 'specialist'],
  ['technical', 'technician'],
  ['satisfaction', 'success'],
];

/** Group mates of a word (itself included when it is in no group). */
function groupMates(word: string): string[] {
  for (const g of SYNONYM_GROUPS) {
    if (g.includes(word)) return g;
  }
  return [word];
}

/** Posting words whose group match is AMBIGUOUS: 'web', 'ui', and 'ts'
 *  all have common non-technical readings ('Web Content', 'UI
 *  Research', 'TS/SCI clearance'). A match that comes ONLY through an
 *  ambiguous word never qualifies a posting on its own — a second,
 *  non-ambiguous match must also be present. Exact matches are never
 *  ambiguous, even for these words. */
const AMBIGUOUS_GROUP_WORDS = new Set(['web', 'ui', 'ts']);

interface TermMatch {
  /** The original resume term. */
  term: string;
  /** The posting word that matched it. */
  via: string;
  /** True when via is the term itself. */
  exact: boolean;
  /** True when the match came through an ambiguous group word. */
  ambiguousOnly: boolean;
}

/** Which resume terms a posting's words match, by exact word or by
 *  synonym group. Crediting runs posting-word-first: each distinct
 *  posting word credits AT MOST ONE resume term — its exact term when
 *  it has one, otherwise the first uncredited group mate that is a
 *  resume term. The old term-first loop let one posting word credit
 *  several resume terms at once ('member' credited customer + client +
 *  member), so a two-word title could score 70 while a real
 *  three-word CS title scored 55. Each resume term still appears at
 *  most once, and results come back in resume-term order so the
 *  strengths list is stable. */
function matchResumeTerms(postingWords: Set<string>, resumeTerms: string[]): TermMatch[] {
  const resumeSet = new Set(resumeTerms);
  const credited = new Map<string, TermMatch>();
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
          ambiguousOnly: AMBIGUOUS_GROUP_WORDS.has(w),
        });
        break;
      }
    }
  }
  return resumeTerms.filter((t) => credited.has(t)).map((t) => credited.get(t)!);
}

/* Full US state names → abbreviations, longest first so 'west
 *  virginia' wins over 'virginia'. Applied to location lines before
 *  any other check — it also fixes a substring trap: 'Indiana'
 *  contains 'india', which the excluded-places check would otherwise
 *  misread as the country. */
const STATE_NAMES: [string, string][] = [
  ['district of columbia', 'dc'],
  ['west virginia', 'wv'],
  ['north carolina', 'nc'],
  ['south carolina', 'sc'],
  ['north dakota', 'nd'],
  ['south dakota', 'sd'],
  ['new hampshire', 'nh'],
  ['new jersey', 'nj'],
  ['new mexico', 'nm'],
  ['new york', 'ny'],
  ['rhode island', 'ri'],
  ['alabama', 'al'],
  ['alaska', 'ak'],
  ['arizona', 'az'],
  ['arkansas', 'ar'],
  ['california', 'ca'],
  ['colorado', 'co'],
  ['connecticut', 'ct'],
  ['delaware', 'de'],
  ['florida', 'fl'],
  ['georgia', 'ga'],
  ['hawaii', 'hi'],
  ['idaho', 'id'],
  ['illinois', 'il'],
  ['indiana', 'in'],
  ['iowa', 'ia'],
  ['kansas', 'ks'],
  ['kentucky', 'ky'],
  ['louisiana', 'la'],
  ['maine', 'me'],
  ['maryland', 'md'],
  ['massachusetts', 'ma'],
  ['michigan', 'mi'],
  ['minnesota', 'mn'],
  ['mississippi', 'ms'],
  ['missouri', 'mo'],
  ['montana', 'mt'],
  ['nebraska', 'ne'],
  ['nevada', 'nv'],
  ['ohio', 'oh'],
  ['oklahoma', 'ok'],
  ['oregon', 'or'],
  ['pennsylvania', 'pa'],
  ['tennessee', 'tn'],
  ['texas', 'tx'],
  ['utah', 'ut'],
  ['vermont', 'vt'],
  ['virginia', 'va'],
  ['washington', 'wa'],
  ['wisconsin', 'wi'],
  ['wyoming', 'wy'],
];

function normalizeStateNames(l: string): string {
  let out = l;
  for (const [name, abbr] of STATE_NAMES) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), ` ${abbr} `);
  }
  return out;
}

/* US-eligibility evidence in a posting's OWN text (title or
 *  description — never page-level boilerplate). Deliberately phrase-
 *  based: a bare 'us' token is a pronoun ('join us') as often as a
 *  country, so it is never evidence on its own. */
const US_EVIDENCE_RES = [
  /\bunited states\b/,
  /\busa\b/,
  /\bu\.s\.a?\b/,
  /\bus-based\b/,
  /\bauthorized to work in the (united states|us)\b/,
  /\beligible to work in the (united states|us)\b/,
  /\bus citizen\b/,
  /\b(based|located|reside|residing) in the united states\b/,
];

function hasUsEvidence(text: string): boolean {
  return US_EVIDENCE_RES.some((re) => re.test(text));
}

/* An explicit non-US-only hiring restriction in the posting's own
 * text (title + description). Catches postings whose location line is
 * blank or bare 'Remote' but which state they hire in an excluded
 * place only, or that US candidates won't be considered — e.g. the
 * Nov 10 CS sweep's Niche roles: 'Sr. Product Analyst (Brazil &
 * Argentina ONLY)', location 'Remote', which passed as 'Remote (US
 * company)'. The location line's own US evidence still wins over
 * this check (see locationVerdict), so a stray place name in a
 * 'Remote, US' posting's description does not reject it. */
const EXCLUDED_PLACES_RE = EXCLUDED_PLACES.join('|');
const NON_US_ONLY_RES = [
  new RegExp(`\\b(${EXCLUDED_PLACES_RE})\\b[^.]{0,60}\\bonly\\b`, 'i'),
  new RegExp(`\\bonly\\b[^.]{0,60}\\b(${EXCLUDED_PLACES_RE})\\b`, 'i'),
  /\bwill not be considering (?:us|u\.s\.|united states)[- ]based candidates\b/i,
  /\bnot considering (?:us|u\.s\.|united states)[- ]based candidates\b/i,
];

function hasNonUsOnlyRestriction(text: string): boolean {
  return NON_US_ONLY_RES.some((re) => re.test(text));
}

export type LocationDisposition = 'ok' | 'review' | 'reject';

/** Three-way location verdict. 'ok' auto-saves normally; 'review'
 *  surfaces the posting as a near miss for manual check, never
 *  auto-added whatever the score; 'reject' drops it. Body text (the
 *  job's own title + description) can only UPGRADE — it can confirm US
 *  eligibility for a bare-'Remote' or empty location, but it can never
 *  override a location line that says hybrid, on-site, an excluded
 *  place, or a state restriction. A posting whose location line says
 *  nothing at all is never silently discarded when it matches skills:
 *  for a U.S. company it passes (a missing location is not a failure),
 *  for any other company it goes to review. */
export function locationVerdict(
  loc: string,
  bodyText: string,
  isUSCompany: boolean = false,
): { verdict: LocationDisposition; flag: string } {
  const body = (bodyText ?? '').toLowerCase();
  const raw = (loc ?? '').toLowerCase();
  if (!raw) {
    // An explicit non-US-only restriction beats the blank-location
    // pass: the posting itself says US candidates are out.
    if (hasNonUsOnlyRestriction(body)) {
      return { verdict: 'reject', flag: 'non-US only (stated in posting)' };
    }
    if (/\bremote\b/.test(body) && hasUsEvidence(body)) {
      return { verdict: 'ok', flag: 'Remote (US, confirmed in posting)' };
    }
    // No location stated. For a U.S. company that is not a failure —
    // the job is in scope and Eric can check the location himself.
    if (isUSCompany) {
      return {
        verdict: 'ok',
        flag: /\bremote\b/.test(body) ? 'Remote (US company)' : 'no location listed — US company',
      };
    }
    if (/\bremote\b/.test(body)) {
      return { verdict: 'review', flag: 'Remote (no country stated — verify)' };
    }
    return { verdict: 'review', flag: 'no location listed — verify' };
  }
  const l = normalizeStateNames(raw);
  if (l.includes('hybrid') || l.includes('on-site') || l.includes('onsite') || l.includes('in office')) {
    return { verdict: 'reject', flag: 'not remote' };
  }
  if (!l.includes('remote')) return { verdict: 'reject', flag: 'not remote' };
  for (const place of EXCLUDED_PLACES) {
    if (l.includes(place)) return { verdict: 'reject', flag: `excluded place: ${place}` };
  }
  const states = l.match(/\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/g) ?? [];
  if (
    l.includes('united states') ||
    l.includes('usa') ||
    l.includes('remote (usa)') ||
    /\bremote\b.*\bus\b/.test(l) ||
    l.includes('anywhere') ||
    l.includes('nationwide')
  ) {
    return { verdict: 'ok', flag: 'Remote (US)' };
  }
  // Bare 'Remote' with no US in the location line: an explicit
  // non-US-only restriction in the posting itself rejects it, before
  // the U.S.-company pass below can let it through.
  if (hasNonUsOnlyRestriction(body)) {
    return { verdict: 'reject', flag: 'non-US only (stated in posting)' };
  }
  if (states.length > 0 && states.every((s) => s === 'tx')) {
    return { verdict: 'ok', flag: 'Remote (TX only)' };
  }
  if (states.length > 0) return { verdict: 'reject', flag: `state-restricted remote: ${[...new Set(states)].join(', ')}` };
  // Bare 'Remote': the location line proves remote but not US
  // eligibility. The job's own text can confirm it, and a U.S.
  // company confirms it by itself; otherwise the posting goes to
  // manual review — 'Remote' alone never auto-adds for a company
  // that is not known to be U.S.
  if (hasUsEvidence(body)) {
    return { verdict: 'ok', flag: 'Remote (US, confirmed in posting)' };
  }
  if (isUSCompany) {
    return { verdict: 'ok', flag: 'Remote (US company)' };
  }
  return { verdict: 'review', flag: 'Remote (no country stated — verify)' };
}

function parsePay(text: string): string {
  const m = text.match(/\$[\d,]{2,}(?:\s*(?:-|–|to)\s*\$?[\d,]{2,})?/);
  return m ? m[0] : '';
}

export interface FinderLead {
  company: string;
  title: string;
  location: string;
  locationFlag: string;
  salaryText: string;
  applyUrl: string;
  description: string;
  postedDate: string;
  matchScore: number;
  strengths: string[];
  gaps: string[];
  /** Why this job may not fit, in plain words: years asked vs shown,
   *  and explicit skill requirements the resume doesn't show. Empty
   *  when nothing specific mismatches. */
  reasons: string[];
  /** Location could not be confirmed as US-remote (bare 'Remote' or no
   *  location): shown as a near miss for manual review, never
   *  auto-added, whatever the score. */
  needsReview: boolean;
  /** Which reader produced the posting: page HTML, an embedded
   *  widget/iframe/embed, or JSON-LD from the same page. */
  sourceType: string;
  /** True when this lead's listing was produced by a portal search
   *  submit (rendered branch only) — search telemetry for the next
   *  sweep, proving the search step fired for this company. */
  searched?: boolean;
}

export interface CompanySearchInput {
  name: string;
  website: string;
  careersUrl: string;
  /** True when the company is known to be a U.S. company. The Finder
   *  roster is U.S.-only by construction (Wikidata country/HQ = US,
   *  SEC EDGAR, U.S. seed list), so Find Jobs passes true; a manually
   *  typed company (Test a company) leaves it unset. */
  isUSCompany?: boolean;
}

export interface CompanySearchResult {
  leads: FinderLead[];
  postingsSeen: number;
  /** The business site's own careers page the jobs were read from. */
  sourcePage: string | null;
  triedUrls: string[];
  /** True when at least one candidate page actually loaded — separates
   *  'pages read, no listings' from 'nothing reachable'. */
  fetchOk: boolean;
  /** The screening funnel for this company: how many postings died on
   *  no resume match, on location, and how many survived only as
   *  review-only (uncertain location). */
  screened: { rejectedNoMatch: number; rejectedLocation: number; reviewLocation: number; rejected: { title: string; location: string; reason: 'no-match' | 'location' }[] };
  /** True when listings came from the browser render fallback. */
  renderUsed: boolean;
  /** True when a render was ATTEMPTED for this company, even when it
   *  failed or found nothing — the honest fire counter. renderMs can
   *  be 0 for a fast render, so it cannot carry this. */
  renderAttempted: boolean;
  /** Milliseconds spent rendering for this company (0 when unused). */
  renderMs: number;
  /** Why an attempted render produced nothing usable — e.g.
   *  'browser-unavailable' (launch/timing) or 'render-failed'
   *  (navigation/load threw inside the render). Null when the render
   *  succeeded or no render was attempted. Surfaces failures that
   *  used to vanish inside render-page.ts's bare null. */
  renderError?: string | null;
  /** The portal-search outcome from the render fallback — what the
   *  search step actually did, so a zero-listing render can be told
   *  apart from a render that never searched. Null when no render ran
   *  or the render failed before the search step. */
  searchOutcome: PortalSearchOutcome | null;
  /** Why the render's search found no box — the scan summary from
   *  the rendered page (inputs seen, visible inputs, best score,
   *  buttons). Null when no render ran or the search found its box. */
  searchScan?: SearchScanSummary | null;
  /** Milliseconds spent inside the portal search step (0 when it never
   *  ran). */
  searchMs: number;
  /** The final URL the render ended on — the results page when the
   *  search navigated. '' when no render ran. */
  renderedUrl: string;
  /** Visible text the render saw ('' when no render ran). A challenge
   *  page, an empty search state, or job titles the extractors
   *  missed — the diagnosis for a zero-listing render. */
  renderTextSample: string;
  /** One entry per render attempt, in order — the target URL, the
   *  milliseconds it took, the portal-search outcome, any render
   *  error, and the URL the render ended on. A null render (the
   *  renderer died or the call threw) is recorded with outcome null
   *  and error 'render-null'. Without this the live canary cannot
   *  tell a retry that never ran from a retry that failed silently
   *  (ModSquad, 2026-11-12: exactly one render per company, and no
   *  field said why the second never fired). */
  renderAttempts?: {
    target: string;
    ms: number;
    outcome: PortalSearchOutcome | null;
    error: string | null;
    renderedUrl: string;
    /** Cookie-banner accept clicks that landed during this render
     *  (0 when no banner was found or the click never fired) and
     *  whether a cookie banner was still covering the page when the
     *  render ended — the Foundever/Sitel diagnostic (2026-11-12):
     *  clicks 0 means the button was never found; clicks > 0 with
     *  the banner still present means the click landed but the
     *  banner came back (reload re-showed it, or the wrong element
     *  was clicked). */
    cookieClicks: number;
    bannerPresent: boolean;
    /** The visible button/link labels the accept step last saw on
     *  this target — what the accept step could see while the banner
     *  was up. */
    bannerButtons: string[];
    /** The label of the element the accept step last clicked on
     *  this target (null when nothing was clicked). */
    cookieClickedLabel: string | null;
    /** Whether a cookie banner was visibly covering the page when
     *  the render ended (a visible element carrying banner text),
     *  as opposed to bannerPresent, which is text in the HTML. */
    bannerVisible: boolean;
    /** The label of the search toggle the search step clicked on
     *  this target (null when no toggle fired). */
    searchToggleClicked: string | null;
    /** The label of the country entry the search step clicked on
     *  this target (null when no country pick fired). */
    searchCountryClicked: string | null;
    /** The label of the last gate action the search step drove on
     *  this target (opener or pick — null when no gate fired). */
    searchGateClicked: string | null;
  }[];
  /** The render targets in the order the loop tried them (best score
   *  first), with their scores — so a live canary can say whether a
   *  portal ever made the target list, and whether it outscored the
   *  marketing page that won the render. */
  renderTargets?: { url: string; score: number }[];
}

/** The fallback keyword for a portal's search box: the resume's two
 *  most frequent terms (e.g. 'service customer' for the demo CS
 *  resume, 'js react' for demo-frontend). Only used when an empty
 *  search returns nothing — the empty search (all jobs) always runs
 *  first, inside the render. Derives from the resume, so it stays
 *  field-correct for any resume. */
export function portalSearchTerm(resumeText: string): string {
  return extractResumeTerms(resumeText).slice(0, 2).join(' ');
}

/** Render options for one company search. Production callers pass the
 *  real renderer; omitting renderPage disables the fallback (tests,
 *  and callers that don't want it). `renderBudget` is a shared
 *  per-invocation cap (mutated as renders are used); when omitted each
 *  company gets a budget of 1. `renderDeadlineMs` is the last epoch at
 *  which a render may start; when omitted it defaults to 30s out. */
export interface SearchCompanyOpts {
  renderPage?: RenderPageFn | null;
  renderBudget?: { used: number; max: number };
  renderDeadlineMs?: number;
}

const GENERIC_TITLE_TEXT = /^(home|about|about us|careers|jobs|job|contact|contact us|login|sign in|join our team|work with us|open positions|current openings|open roles|all roles|see all jobs|view all jobs|view jobs|see jobs|browse jobs|search jobs|browse all jobs|view openings|see openings|view open positions|all jobs|all positions|explore careers|explore jobs|learn more|apply now|view details|view job|see details)$/i;

function resolvePageLink(href: string, pageUrl: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) return null;
  try {
    const abs = new URL(h, pageUrl).href;
    return abs.startsWith('http://') || abs.startsWith('https://') ? abs : null;
  } catch {
    return null;
  }
}

function cleanTitle(text: string): string {
  return stripTags(text).replace(/\s+/g, ' ').trim();
}

function titleOk(title: string): boolean {
  if (title.length < 2 || GENERIC_TITLE_TEXT.test(title)) return false;
  // "See open roles", "View jobs", "Browse positions" — hub/hero copy,
  // never a role title.
  if (/^(see|view|browse|explore|find|search|discover)\b/i.test(title) && /\b(jobs?|roles?|openings?|positions?|careers?|opportunities)\b/i.test(title)) return false;
  // A title ending in a call-to-action is a fragment glued to its
  // link label, not a role: Strategy A's link-text fallback on a
  // Rippling row reads "Agent Success Remote (United States) View
  // job" — the real title is the first segment, which Strategy E
  // takes. A real role title never ends in "View job" / "Apply".
  if (/\b(view (job|details|opening)|apply( now)?|see details|learn more)$/i.test(title)) return false;
  return true;
}

function locationIn(text: string): string {
  // The LAST "Location:" line / location span in the text wins: a
  // Strategy B window (900 chars before an apply link) can span two
  // cards, and the location closest to the link is the card's own —
  // the first match would be the PREVIOUS card's (2026-11-12 local
  // round: a Remote card read "Virginia, US" off the Retention card
  // above it). Per-card chunks carry a single location, so first and
  // last agree there.
  let lastLoc = '';
  for (const m of text.matchAll(/Location:\s*([^<\n]{2,60})/gi)) {
    const v = stripTags(m[1]).trim();
    if (v) lastLoc = v;
  }
  if (lastLoc) return lastLoc;
  // A location element: <span class="location">Kingston, Jamaica</span>
  // or <span class="job-location">…</span> (TalentBrew). Strategy A
  // chunks and Strategy C cards carry the location this way; without
  // it the role reads as blank-location and a non-US on-site role
  // passes the sweep's location rule as a review lead
  // (Teleperformance's Jamaica role, 2026-11-12 local round).
  // The span may carry nested inline markup (an <i> map-marker icon
  // inside it): the capture allows tags and strips them, instead of
  // requiring bare text directly after the open tag — a span that
  // reads blank for that reason lets an on-site role through as a
  // review lead (Sitel's live Phenom cards, 2026-11-12 canary).
  // A <div>/<p> with an exact 'location' / 'job-location' class
  // token counts too — but only the exact token: a
  // 'location-filter' div holds a list of places, not the card's
  // own location.
  const cleanSpan = (raw: string): string => {
    const v = stripTags(raw).replace(/\s+/g, ' ').trim();
    return v.length >= 2 && v.length <= 80 ? v : '';
  };
  let lastSpan = '';
  for (const m of text.matchAll(
    /<span[^>]*class="[^"]*(?:job-)?location[^"]*"[^>]*>([\s\S]{0,120}?)<\/span>/gi,
  )) {
    const v = cleanSpan(m[1]);
    if (v) lastSpan = v;
  }
  if (lastSpan) return lastSpan;
  for (const m of text.matchAll(
    /<(div|p)[^>]*class="([^"]*)"[^>]*>([\s\S]{0,120}?)<\/\1>/gi,
  )) {
    const tokens = m[2].split(/\s+/);
    if (!tokens.some((t) => t === 'location' || t === 'job-location')) continue;
    const v = cleanSpan(m[3]);
    if (v) lastSpan = v;
  }
  if (lastSpan) return lastSpan;
  if (/\bRemote\b/i.test(text)) return 'Remote';
  return '';
}

/** The location a Phenom-style job URL carries in its slug:
 *  /job/<City>-<Title-words>-<State>/<numeric-id>/
 *  (jobs.foundever.com: /job/Wise-Retention-Customer-Service-
 *  Associate-Virg/1372881000/, /job/Remote-Remote-Customer-Service-
 *  Representative-Any/1450284100/). Used ONLY when the card itself
 *  carries no readable location: the slug is the portal's own
 *  statement of where the role sits, and a blank location would
 *  otherwise pass the remote-only sweep as a review lead (Sitel's
 *  Retention role, live 2026-11-12 canary — Wise, VA on-site, read
 *  blank). A slug starting in 'Remote' is remote; any other slug
 *  must end in a resolvable US state token (a 2-letter abbreviation,
 *  or a truncated state name — 'Virg' maps by name prefix) or it
 *  returns '' — a plain title slug (/job/customer-service-
 *  representative/123/) proves no location and must never become
 *  one. Never a guess. */
export function locationFromJobSlug(rawUrl: string): string {
  let path = '';
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return '';
  }
  const segs = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length !== 3 || segs[0].toLowerCase() !== 'job') return '';
  if (!/^\d+$/.test(segs[2])) return '';
  const tokens = segs[1].split('-').filter(Boolean);
  if (tokens.length < 2) return '';
  if (!tokens.every((t) => /^[A-Za-z0-9]+$/.test(t))) return '';
  const stateOf = (tok: string): string => {
    if (/^[A-Za-z]{2}$/.test(tok)) {
      const abbr = tok.toUpperCase();
      return STATE_NAMES.some(([, a]) => a.toUpperCase() === abbr) ? abbr : '';
    }
    // A truncated state name: exactly one state name may start with
    // it ('Virg' -> Virginia, 'Tex' -> Texas). An ambiguous prefix
    // ('New' -> four states) or a title word ('Ass', 'Rep') matches
    // none or several, and proves no state.
    if (tok.length >= 3) {
      const hits = STATE_NAMES.filter(([name]) => name.startsWith(tok.toLowerCase()));
      return hits.length === 1 ? hits[0][1].toUpperCase() : '';
    }
    return '';
  };
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (/^remote$/i.test(first)) {
    const st = stateOf(last);
    return st ? `Remote, ${st}` : 'Remote';
  }
  const st = stateOf(last);
  if (!st) return '';
  return `${first}, ${st}`;
}

/** De-slugify a job-detail URL into a role title: the role segment is
 *  the last slug-like segment that is not a bare id and not a generic
 *  path word. iCIMS: /jobs/80868/customer-service-expert/job ->
 *  'Customer Service Expert'. Segments are split on hyphens; empty
 *  tokens (from '---') and pure-number tokens are dropped; each word
 *  is title-cased. Returns '' when no role-like segment exists (a
 *  bare id, a list page). */
export function titleFromJobSlug(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return '';
  }
  const segs = u.pathname.toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean);
  const SKIP = new Set([
    'job', 'jobs', 'jobsearch', 'career', 'careers', 'apply', 'application',
    'details', 'detail', 'position', 'positions', 'opening', 'openings',
    'posting', 'postings', 'vacancy', 'vacancies', 'role', 'roles', 'view',
    'search', 'results', 'browse', 'list', 'en-us', 'en',
  ]);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (/^\d+$/.test(seg)) continue;
    if (SKIP.has(seg)) continue;
    const words = seg
      .split('-')
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter((w) => w && !/^\d+$/.test(w));
    if (words.length < 2) continue;
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return '';
}

const APPLY_HREF = /job|apply|position|opening|detail|career|posting|vacancy|role/i;

/** A parsed HTML listing counts as a REAL posting only when it looks
 *  like one specific role — not a nav / category / CTA link. Proven
 *  junk (live homepages, 2026-11-11): TTEC 'Customer service jobs'
 *  -> /en/customer-service, 'Sales jobs' -> /en/sales (category
 *  links); Working Solutions 'Ready to Build Better Customer
 *  Operations?' -> jobs.workingsolutions.com/ (portal root);
 *  Sutherland 'Cookies Preferences' -> /cookie-preferences (footer
 *  link, passed only because its chunk contained the word Remote);
 *  Kelly 'Looking for your next opportunity?' -> /find-a-job/.
 *  Real postings look like Arise 'REMOTE CALL CENTER REPRESENTATIVE
 *  – WORK FROM HOME' -> /program/remote-call-center-representative-
 *  work-from-home-47/ (specific slug + numeric id) or a job block
 *  'Frontend Developer' -> /jobs/frontend-developer. Junk is dropped
 *  at parse time: it never reaches postingsSeen, never screens into a
 *  lead, and — the load-bearing part — never triggers the walk's
 *  early return, so a junk-only page stays eligible for the
 *  render+search fallback instead of stranding the company at zero.
 *  JSON-LD and embedded-widget postings bypass this gate (they never
 *  go through parseCareersPage): a schema.org JobPosting or a board
 *  embed's own jobs list is real by construction. */
export function isJunkTitle(title: string): boolean {
  const t = (title ?? '').trim();
  if (!t) return true;
  // A question is a CTA, never a role: 'Ready to Build Better
  // Customer Operations?', 'Looking for your next opportunity?'.
  if (/\?\s*$/.test(t)) return true;
  // A sentence is marketing copy, never a role: Teleperformance's
  // values page parses as a posting titled 'We believe that all
  // employees need to be treated with respect, dignity, and
  // acceptance.' — a 15-word sentence ending in a period. The word
  // count guards abbreviations: 'Customer Service Rep.' is three
  // words and a real title; a six-word sentence is not.
  if (/\.\s*$/.test(t) && t.split(/\s+/).length >= 6) return true;
  // A pagination / nav label is never a role: TTEC's pager link
  // ("Next") became a posting titled "Next" via Strategy A's
  // link-text fallback (the trailing chunk has no heading,
  // 2026-11-12 local round). A real role title is never exactly
  // one of these words.
  if (/^(next|previous|prev|back|more|load more|show more|view all)$/i.test(t)) return true;
  // A talent-pool / signup CTA is never a role: Paylocity's "Share
  // Your Information" (a link to join the talent pool) parsed as a
  // posting and inflated NexRep's postingsSeen to 4 (2026-11-12
  // canary). Same shape: Workday's "Introduce Yourself", and any
  // "submit/upload your CV" pool link. A real role title never
  // starts with one of these phrases.
  if (/^(share your (information|info|details)|submit your (information|info|application)|upload your (cv|resume|information|profile)|introduce yourself)\b/i.test(t)) return true;
  // A real job title never starts with one of these verbs.
  if (/^(join|become|apply)\b/i.test(t)) return true;
  // Category labels: 'Jobs near you', 'Jobs for veterans ...',
  // 'Customer service jobs', 'Sales jobs', 'Licensed insurance
  // agents careers', 'Current Career Opportunities'.
  if (/^\s*jobs?\b/i.test(t)) return true;
  if (/\b(jobs|careers|openings|positions|roles|opportunities)\s*$/i.test(t)) return true;
  return false;
}

/** The list words a URL path ends in when it is a listing/category
 *  page, not one job: /jobs, /careers, /job-search, /find-a-job,
 *  /search, /results, and friends. */
const LIST_PATH_WORDS = /^(jobs?|careers?|job-search|jobsearch|find-a-job|find-jobs|search-jobs|search|results|openings|positions|roles|opportunities)$/i;

export function isJobDetailUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // Explicit detail query params first — a list page never carries
  // one, and Concentrix's real detail links are /job/?id=R1779018
  // (whose last path segment, 'job', would otherwise veto below).
  const q = u.searchParams;
  for (const k of ['id', 'jobid', 'job_id', 'gh_jid', 'req', 'reqid', 'job', 'position', 'posting']) {
    const v = q.get(k);
    if (v && v.trim()) return true;
  }
  const segs = u.pathname.toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length === 0) return false; // portal root: a list, not a job
  const last = segs[segs.length - 1];
  // iCIMS detail URLs end in a literal '/job' after the role slug:
  // /jobs/<id>/<role-slug>/job — the trailing 'job' is part of the
  // detail path, not a list page (TP's opportunities page, 2026-11-12
  // probe: 4 such links, all real roles). The numeric id + a 2+-word
  // role slug prove it; a bare /jobs/<id>/job with no slug, or a
  // list page ending in /job, still falls through to the veto below.
  if (
    last === 'job' &&
    segs.length >= 3 &&
    /^\d+$/.test(segs[segs.length - 3]) &&
    segs[segs.length - 2].split('-').filter(Boolean).length >= 2
  ) {
    return true;
  }
  if (LIST_PATH_WORDS.test(last)) return false;
  // A category slug: the last segment starts with a job-marker word
  // ('job-', 'career-', 'jobs-', 'careers-') and the rest is a
  // topic, not a role ('career-advice', 'job-opportunities',
  // 'job-search'). Kelly's 'Help & Support' nav item links to
  // /career-advice, and the old 'career'-substring rule called it a
  // job — it scored 60 and became a lead (2026-11-12 round-6
  // canary). A segment that starts with a marker word is a detail
  // only when a later token is a detail word ('career-details'
  // survives; 'career-advice' does not). The marker-substring rule
  // below still admits role slugs under a /jobs/ or /careers/ path.
  if (/^(job|jobs|career|careers)-/i.test(last)) {
    const rest = last.split('-').slice(1);
    if (!rest.some((t) => /^(detail|details|job|position|opening|posting|role|apply|vacancy)$/i.test(t))) {
      return false;
    }
  }
  // A search / list / pagination URL is never one job: TTEC's pager
  // is /search-jobs&p=2 (the Next link) — the "job marker anywhere"
  // rule below would call it a detail (the path contains "job"), and
  // Strategy A's link-text fallback then titles it "Next", so the
  // sweep sees a 9th posting on a page with 8 cards (2026-11-12
  // local round). A real detail's last segment is a role slug or a
  // numeric id, never a search word; a p=/page= marker is pagination.
  if (/^(search|results|browse|find|list)/i.test(last) || /[?&]p(ag)?=\d/i.test(rawUrl)) {
    return false;
  }
  // A job marker as a full segment or a segment start:
  // /jobs/frontend-developer, /careers/frontend, /career-details,
  // /position/123. NOT a marker buried mid-segment: /about-careers/
  // is a marketing page, not a job — the old substring rule called
  // it a detail, and the render-target exclusion then dropped a page
  // the loop must still be able to try (the target-order test pins
  // it, 2026-11-12 local round).
  if (segs.some((s) => /^(job|jobs|career|careers|position|opening|posting|vacancy|apply|detail|role)/i.test(s))) return true;
  // A numeric id in the last segment: /program/remote-call-center-
  // representative-work-from-home-47/, /jobs/12345.
  if (/\d/.test(last)) return true;
  // A long specific slug: a role slug runs to four or more hyphenated
  // words, a category slug stops at three ('technology-and-digital').
  if (last.split('-').filter(Boolean).length >= 4) return true;
  return false;
}

/** Both halves of the real-posting gate: a specific role title AND a
 *  job-detail link. Either half failing drops the listing. */
export function isRealPosting(title: string, url: string | null): boolean {
  if (!url) return false;
  return !isJunkTitle(title) && isJobDetailUrl(url);
}

/** Parse job listings straight off a company's own careers page HTML:
 *  job blocks (class/id mentioning job/career/position/opening) and
 *  title + View-details/Apply link pairs. Only REAL listings are
 *  kept: a usable title that names one specific role AND an
 *  apply/detail link shaped like one job (see isRealPosting) — a
 *  category link, portal root, hero banner, nav link, or 'see open
 *  roles' hub link never qualifies, even when its chunk states a
 *  location. Script/style content is stripped first so widget code
 *  can't ghost-match. */
export function parseCareersPage(html: string, pageUrl: string): Posting[] {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const postings: Posting[] = [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>(); // URLs already pushed, so Strategy F can skip them.
  const push = (title: string, location: string, url: string | null) => {
    if (!titleOk(title) || !url) return;
    if (!isRealPosting(title, url)) return;
    // Keyed by title AND url: some pages (Webflow lists) give every
    // role the same generic detail link, and keying by url alone would
    // collapse distinct roles into one.
    const key = `${title}\n${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenUrls.add(url);
    // A card with no readable location still carries one in its
    // Phenom slug — read it there rather than passing the role on
    // as blank-location (Sitel's Retention role, 2026-11-12).
    postings.push({ title, location: location || locationFromJobSlug(url), url, description: '', postedDate: '' });
  };
  // Strategy A: job blocks. The splitter fires on a class/id that
  // mentions a job word — but NOT a bare location element: a
  // <span class="job-location"> is the card's location display, not
  // a card, and splitting on it shatters the card from its own span
  // (the card chunk then reads blank and the slug fallback has to
  // rescue the location — Sitel's live Phenom cards, 2026-11-12
  // canary). 'job-card' / 'job-list' still split; 'job-location'
  // (and 'job-locations') do not. A <a data-job-id> is a card
  // container too (TalentBrew): without it, the chunk starts at the
  // inner h2 — which sits INSIDE the card's anchor — and Strategy A
  // pairs the title with the NEXT card's link (the first <a> in the
  // chunk), crossing titles and URLs. Splitting on the anchor keeps
  // each card's title, link, and span in one chunk.
  const chunks = clean.split(/(?=<[^>]*\b(?:(?:class|id)="[^"]*(?:job(?!-location)|career|position|opening)[^"]*"|data-job-id="[^"]+"))/i);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].slice(0, 3000);
    const heading = chunk.match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    const strong = chunk.match(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/i);
    const link = chunk.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/i);
    let title = '';
    if (heading) title = cleanTitle(heading[1]);
    if (!titleOk(title) && link) title = cleanTitle(link[2]);
    if (!titleOk(title) && strong) title = cleanTitle(strong[1]);
    if (!titleOk(title)) continue;
    let apply: string | null = null;
    let first: string | null = null;
    const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let lm: RegExpExecArray | null;
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
  // Strategy C: job-card anchors — portals whose job list is a row of
  // <a class="...job-card..."> cards wrapping an <h3> title
  // (Concentrix JDQ, and the same shape on other card-based boards).
  // Strategy A cannot see these: its splitter fires on every inner
  // element whose class mentions "job" (the card, its title, its
  // description, its meta row), shattering one card into title-less
  // and link-less fragments — the card anchor keeps the href but no
  // heading, the heading chunk keeps the title but no link, and both
  // are skipped. Match the whole card anchor at once instead: the
  // href is the apply link, the first heading inside is the title,
  // and the card's text carries the location. The 6000-char cap is
  // headroom for long descriptions + inline SVG icons inside a card.
  const cardAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cardAnchorRe.exec(clean)) !== null) {
    const openTag = cm[0].slice(0, cm[0].indexOf('>') + 1);
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
  // Strategy D: TalentBrew list anchors — <a data-job-id="…"> wrapping an
  // <h2> title + a .job-location span (TTEC). The anchor carries NO class,
  // so Strategy C's class test skips it, and Strategy A's splitter fires on
  // the inner h2/span, shattering title from link. data-job-id is the
  // TalentBrew marker; the h2 is the title; the .job-location span is the
  // location (locationIn() returns '' here — no "Location:" prefix, no
  // "Remote" word — so read the span directly).
  const tbAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tbAnchorRe.exec(clean)) !== null) {
    const tbOpenTag = tm[0].slice(0, tm[0].indexOf('>') + 1);
    // NOTE: href comes BEFORE data-job-id in the real markup
    // (<a href="…" data-job-id="…">), so the marker must be tested on the
    // open tag, not ordered before the href in the pattern.
    if (!/\bdata-job-id=["']\d+["']/i.test(tbOpenTag)) continue;
    const tbHeading = tm[2].match(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/i);
    if (!tbHeading) continue;
    const tbTitle = cleanTitle(tbHeading[1]);
    if (!titleOk(tbTitle)) continue;
    const tbApply = resolvePageLink(tm[1], pageUrl);
    if (!tbApply) continue;
    const tbLocSpan = tm[2].match(
      /<span[^>]*class="[^"]*job-location[^"]*"[^>]*>([\s\S]{0,120}?)<\/span>/i,
    );
    const tbLoc = tbLocSpan ? stripTags(tbLocSpan[1]).trim() : locationIn(tm[2]);
    if (!APPLY_HREF.test(tbApply) && !tbLoc) continue;
    push(tbTitle, tbLoc, tbApply);
  }
  // Strategy E: ATS rows that are bare anchors to a job-detail UUID
  // (Rippling: <a href="/liveops/jobs/<uuid>"><div>Agent Success
  // </div><div>Remote (United States)</div> … View job</a>). No
  // heading, no job-ish class, no data-job-id — Strategies A-D all
  // miss them, and the walk discovered the detail URLs from the list
  // page (Liveops, 2026-11-12), proving the anchors exist even though
  // no strategy parses them. The /jobs/<uuid> path is the marker; the
  // first title-like text segment inside the anchor is the title
  // (a location segment — "Remote (United States)" — is skipped, it
  // is not a role); the location comes from locationIn() on the
  // anchor's inner HTML. The UUID shape keeps this off ordinary
  // links (a Lever apply link carries no title segment inside it).
  const uuidAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let um: RegExpExecArray | null;
  while ((um = uuidAnchorRe.exec(clean)) !== null) {
    if (!/\/jobs?\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(um[1])) continue;
    const uuidApply = resolvePageLink(um[1], pageUrl);
    if (!uuidApply) continue;
    // Title: the first text segment inside the anchor that reads like
    // a role title. Split the inner HTML on tags so segments stay
    // separate — a flat stripTags would glue the title to the
    // location and the "View job" label into one string.
    let uuidTitle = '';
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
  // Strategy F: apply-link cards — the anchor IS the CTA ("APPLY NOW",
  // "Apply", "View job") and the role title lives only in the URL slug
  // (iCIMS: /jobs/<id>/<role-slug>/job — the card's title is a <div>
  // no strategy reads, so A–E all miss it; the live probe of TP's
  // opportunities page shows 4 such links and 0 parsed postings,
  // 2026-11-12). The slug is the title. Skip URLs an earlier strategy
  // already pushed, and skip slugs that are not role-like (a bare id,
  // a process page with no role segment).
  const CTA_TEXT = /^(apply\s*now|apply|view\s*job|view\s*details?|see\s*details?|see\s*job|view\s*opening|view\s*role)\b/i;
  const applyAnchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = applyAnchorRe.exec(clean)) !== null) {
    const ctaText = cleanTitle(fm[2]);
    if (!CTA_TEXT.test(ctaText)) continue;
    const applyUrl = resolvePageLink(fm[1], pageUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) continue;
    if (!isJobDetailUrl(applyUrl)) continue;
    const slugTitle = titleFromJobSlug(applyUrl);
    if (!titleOk(slugTitle)) continue;
    push(slugTitle, '', applyUrl);
  }
  // Strategy B: View-details / Apply links with a title just before them.
  const viewRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let vm: RegExpExecArray | null;
  while ((vm = viewRe.exec(clean)) !== null) {
    if (!/view details|view job|apply|see details|learn more/i.test(cleanTitle(vm[2]))) continue;
    const apply = resolvePageLink(vm[1], pageUrl);
    if (!apply) continue;
    const windowText = clean.slice(Math.max(0, vm.index - 900), vm.index);
    const headings = [...windowText.matchAll(/<h[234][^>]*>([\s\S]{0,200}?)<\/h[234]>/gi)];
    const bolds = [...windowText.matchAll(/<(?:strong|b)[^>]*>([\s\S]{0,200}?)<\/(?:strong|b)>/gi)];
    let title = '';
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

/** Parse schema.org JobPosting blocks embedded in the SAME careers
 *  page HTML. Same-page structured data only: nothing new is fetched,
 *  and fields are never merged across blocks — each JobPosting object
 *  becomes one posting or nothing. Entries whose apply URL leaves the
 *  business site for a board, entries with no usable apply link, and
 *  entries past validThrough are skipped: the visible listings on the
 *  page are the primary source, and JSON-LD only adds what the visible
 *  HTML doesn't already show (the caller drops title dupes). */
export function parseJsonLdPostings(html: string, pageUrl: string): Posting[] {
  const postings: Posting[] = [];
  const locationFromJobLocation = (jl: any): string => {
    if (!jl) return '';
    if (typeof jl === 'string') return jl.trim();
    if (Array.isArray(jl)) {
      for (const item of jl) {
        const s = locationFromJobLocation(item);
        if (s) return s;
      }
      return '';
    }
    if (typeof jl === 'object') {
      const addr = jl.address;
      if (addr && typeof addr === 'object') {
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x: string) => x.trim());
        if (parts.length > 0) return parts.join(', ');
      }
      if (typeof jl.name === 'string') return jl.name.trim();
    }
    return '';
  };
  const requirementText = (req: any): string => {
    if (!req) return '';
    if (typeof req === 'string') return req.trim();
    if (Array.isArray(req)) {
      for (const item of req) {
        const s = requirementText(item);
        if (s) return s;
      }
      return '';
    }
    if (typeof req === 'object' && typeof req.name === 'string') return req.name.trim();
    return '';
  };
  const pushPosting = (j: any) => {
    const title = typeof j.title === 'string' ? cleanTitle(j.title) : '';
    if (!titleOk(title)) return;
    let url: string | null = null;
    if (typeof j.url === 'string' && j.url.trim()) {
      try {
        const abs = new URL(j.url.trim(), pageUrl).href;
        if (abs.startsWith('http://') || abs.startsWith('https://')) url = abs;
      } catch {
        // Unusable URL — the posting is skipped below.
      }
    }
    if (!url || isBoardUrl(url)) return;
    if (typeof j.validThrough === 'string') {
      const vt = new Date(j.validThrough);
      if (!Number.isNaN(vt.getTime()) && vt.getTime() < Date.now()) return;
    }
    const description = typeof j.description === 'string' ? stripTags(j.description) : '';
    let location = '';
    const locType = j.jobLocationType;
    const locTypes = Array.isArray(locType) ? locType : [locType];
    const telecommute = locTypes.some(
      (t) => typeof t === 'string' && t.toUpperCase().includes('TELECOMMUTE'),
    );
    const reqText = requirementText(j.applicantLocationRequirements);
    if (telecommute) {
      location = reqText ? `Remote, ${reqText}` : 'Remote';
    } else {
      location = locationFromJobLocation(j.jobLocation) || reqText;
    }
    let postedDate = '';
    if (typeof j.datePosted === 'string') {
      const d = new Date(j.datePosted);
      if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
    }
    postings.push({ title, location, url, description, postedDate });
  };
  const collect = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) collect(n);
      return;
    }
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('JobPosting')) {
      pushPosting(node);
      return;
    }
    if (node['@graph']) collect(node['@graph']);
  };
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    try {
      collect(JSON.parse(sm[1]));
    } catch {
      // Malformed JSON-LD — ignore the block, keep the page's listings.
    }
  }
  return postings.slice(0, 50);
}

/** Search ONE company — business site ONLY, no exceptions. Jobs come
 *  from the company's own pages and nowhere else: listings parsed
 *  straight off a page, or the job displays embedded in that page (a
 *  widget, an iframe, a job board embed script — all part of the
 *  page's own display). A board link is never fetched as a source —
 *  not a link the user pasted, not a link found on the company's
 *  pages. The ONLY board contact allowed is the apply link on a
 *  listing found on the business page: if applying takes the user to
 *  a board, that's fine, but the job itself was found on the company's
 *  site. Shared by the full Find Jobs sweep and by the single-company
 *  test — so a test predicts exactly what the sweep would find for
 *  that company. */
/** Links on a page that look like a careers page: the href mentions
 *  careers/jobs, or the link text does (nav "Careers", "Open
 *  positions", "Join our team"). Relative links resolve against the
 *  page URL. Capped at 3 so a big nav can't turn into a crawl. */
function careersLinksOnPage(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    // Hrefs carry HTML entities (&amp;, &#038;) — without decoding,
    // the same link appears as several different URLs and burns the
    // 8-candidate cap (Foundever: 5 UTM/locale spellings of the one
    // jobs.foundever.com link, 2026-11-11 canary).
    const href = m[1].replace(/&amp;/gi, '&').replace(/&#0?38;/gi, '&').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    const text = stripTags(m[2]).trim();
    const hrefHits = /career|job/i.test(href);
    const textHits = /career|job|open positions|join (us|our|the) team|work with us/i.test(text);
    if (!hrefHits && !textHits) continue;
    try {
      const abs = new URL(href, pageUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      // Unparseable href — skip.
    }
  }
  return out.slice(0, 3);
}

/** Every way one page displays jobs, unioned: listings in the page's
 *  own HTML, plus its embedded widget, iframe, or job board embed. A
 *  page can carry more than one (House Rx lists a few Webflow roles
 *  AND embeds its Greenhouse board), and taking only the first source
 *  would hide the rest. All of these are the page's own display — no
 *  board is ever visited as a separate source, and a board link found
 *  on the page is never followed. `rendered` is true when the HTML
 *  came from the browser fallback: page listings are then stamped
 *  'rendered' so provenance shows the render path produced them. */
/** The "Next page" link of a job list, or null. Matches an anchor
 *  whose text is exactly "Next" (allowing trailing glyphs like »),
 *  rel="next", or class "next" — the TalentBrew shape is
 *  `<a class="next" href="/search-jobs&p=2">Next</a>`. Same-host
 *  only, never a board URL, never the page itself. */
function nextPageUrl(html: string, pageUrl: string): string | null {
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const text = stripTags(m[2]).replace(/[^a-z]/gi, '').toLowerCase();
    const isNext =
      text === 'next' ||
      /\brel=["']?next["']?/i.test(openTag) ||
      /\bclass=["'][^"']*\bnext\b[^"']*["']/i.test(openTag);
    if (!isNext) continue;
    // hrefs carry HTML entities (&amp;) — resolvePageLink does not
    // decode them, so &amp;p=2 would fetch a dead path.
    const abs = resolvePageLink(m[1].replace(/&amp;/gi, '&'), pageUrl);
    if (!abs || isBoardUrl(abs)) continue;
    try {
      if (new URL(abs).hostname !== new URL(pageUrl).hostname) continue;
    } catch {
      continue;
    }
    if (abs.replace(/\/+$/, '') === pageUrl.replace(/\/+$/, '')) continue;
    return abs;
  }
  return null;
}

async function collectPagePostings(html: string, pageUrl: string, rendered: boolean): Promise<Posting[]> {
  const pagePostings: Posting[] = [];
  const seenKeys = new Set<string>();
  const addPostings = (ps: Posting[], source: string) => {
    for (const p of ps) {
      const k = `${p.title}\n${p.url}`;
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        pagePostings.push({ ...p, source });
      }
    }
  };
  addPostings(parseCareersPage(html, pageUrl), rendered ? 'rendered' : 'html');
  // Pagination: a real list page that links "Next" has more roles
  // behind it (TalentBrew: 8/page over 38 pages; Concentrix JDQ:
  // 10/page over ~190). The list pages are server-rendered, so
  // plain fetches suffice — no browser needed for pages 2+. Up to 3
  // extra pages, stopping the moment a page adds nothing new, and
  // never past 50 postings for one company. Bounded so one company
  // can never eat the chunk's time budget; a Next link that points
  // back at a visited page (or off-site, or onto a board) ends the
  // walk. Only runs when page 1 yielded real postings, so a
  // non-list page never paginates.
  if (pagePostings.length > 0) {
    const seenPages = new Set<string>([pageUrl.replace(/\/+$/, '')]);
    let nextUrl = nextPageUrl(html, pageUrl);
    let extraPages = 0;
    while (nextUrl && extraPages < 3 && !seenPages.has(nextUrl.replace(/\/+$/, ''))) {
      seenPages.add(nextUrl.replace(/\/+$/, ''));
      let nextHtml: string;
      try {
        nextHtml = await fetchText(nextUrl);
      } catch {
        break;
      }
      const before = pagePostings.length;
      addPostings(parseCareersPage(nextHtml, nextUrl), rendered ? 'rendered' : 'html');
      extraPages += 1;
      if (pagePostings.length === before) break; // empty page: the list is done
      if (pagePostings.length >= 50) break; // company cap
      nextUrl = nextPageUrl(nextHtml, nextUrl);
    }
  }
  const widgetSlug = jazzhrWidgetSlug(html);
  if (widgetSlug) {
    try {
      addPostings(
        parseJazzhrWidget(
          await fetchText(`https://app.jazz.co/widgets/basic/create/${widgetSlug}`),
        ),
        'jazzhr',
      );
    } catch {
      // Widget unreadable — the page's other sources still count.
    }
  }
  const iframeUrl = isolvedIframeUrl(html);
  if (iframeUrl) {
    try {
      addPostings(parseIsolvedIframe(await fetchText(iframeUrl), iframeUrl), 'isolved');
    } catch {
      // Iframe unreadable — the page's other sources still count.
    }
  }
  const ghSlug = greenhouseEmbedSlug(html);
  if (ghSlug) {
    try {
      addPostings(
        parseGreenhouseJobs(
          await fetchText(
            `https://boards-api.greenhouse.io/v1/boards/${ghSlug}/jobs?content=true`,
          ),
        ),
        'greenhouse',
      );
    } catch {
      // Embed unreadable — the page's other sources still count.
    }
  }
  // JSON-LD last: a block whose title is already visible adds no NEW
  // posting — but its description/location are the only description
  // the visible listing will ever get (the HTML parser reads titles
  // + links only, so visible postings carry description ''). Merge
  // the structured fields into the visible posting instead of
  // dropping the block: without this, matching is title-only and a
  // real CS description can never lift a score past 60.
  const byTitle = new Map(pagePostings.map((p) => [p.title.toLowerCase(), p]));
  for (const jp of parseJsonLdPostings(html, pageUrl)) {
    const vis = byTitle.get(jp.title.toLowerCase());
    if (vis) {
      if (!vis.description && jp.description) vis.description = jp.description;
      if (!vis.location && jp.location) vis.location = jp.location;
      if (!vis.postedDate && jp.postedDate) vis.postedDate = jp.postedDate;
    } else {
      addPostings([jp], 'jsonld');
    }
  }
  return pagePostings;
}

/** Score a zero-yielding candidate as the ONE page worth rendering.
 *  The render budget is one page per company, so it must go to the
 *  page most likely to be the job list — not the first zero-yielding
 *  candidate the walk happens to hit. A search/results URL wins
 *  outright (Concentrix: /united-states/ is an FAQ/culture page with
 *  no search box, while /job-search/ is the portal — rendering the
 *  first and spending the budget strands the company at zero). A
 *  plain /search page is next, then any /jobs or /careers path, then
 *  the careers link the user gave (worth more than a guessed sibling
 *  path). Equal scores break toward the earliest candidate in walk
 *  order, so /careers still beats /jobs when both are guesses. */
/** Known applicant-tracking-system hosts. A candidate on one of these
 *  is the employer's real job portal, not a marketing page that merely
 *  links to one: Liveops' Rippling board, ModSquad's Workday, NexRep's
 *  Paylocity, and Alorica's bling-ai portal all lost the render to a
 *  same-host marketing page (5 vs 2) because the ATS host scored
 *  nothing (2026-11-11 canary). Board hosts (Greenhouse, Lever,
 *  Ashby, JazzHR, ApplyToJob) are deliberately NOT here — isBoardUrl
 *  already refuses them as sources, and they must never earn a
 *  portal bonus. */
const ATS_HOST_SIGNS = [
  'myworkdayjobs', 'rippling', 'paylocity', 'smartrecruiters', 'icims',
  'taleo', 'successfactors', 'eightfold', 'phenom', 'brassring', 'adp',
  'ultipro', 'breezy', 'workable', 'fountain', 'talentbrew', 'radancy',
  'avature', 'jobvite', 'recruitee', 'clearcompany', 'dayforce',
  'peoplefluent', 'lumesse', 'harri', 'hiringthing', 'teamtailor',
  'personio', 'jobadder', 'bling-ai',
];

export function atsHostBonus(u: string): number {
  try {
    const host = new URL(u).hostname.toLowerCase();
    // +8, not +6: at +6 ModSquad's Workday portal (6 + 0 content +
    // 3 host = 9) lost the render to the join marketing page (2 + 5
    // content + 3 host = 10) by one point (2026-11-12 canary) — the
    // retry then never fired, so the portal was never reached. A
    // known ATS host IS the portal, so it must clear a marketing
    // page's content score outright: 8 + 0 + 3 = 11 > 10.
    return ATS_HOST_SIGNS.some((s) => host.includes(s)) ? 8 : 0;
  } catch {
    return 0;
  }
}

export function renderTargetScore(u: string, careersUrl: string): number {
  let score = 0;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.toLowerCase();
    // +7, not +5: the jobs-subdomain homepage rule below is +6, so a
    // /job-search/ path must stay above it — the search page is the
    // most specific portal URL there is (Concentrix's /job-search/
    // is the portal; the bare jobs.concentrix.com homepage is not).
    // At +5 the bare homepage (6) outranked /job-search/ (5) and the
    // render went to a shell page instead of the portal.
    if (/job-search|search-results|\/results(\/|$)/.test(path)) score += 7;
    else if (/search/.test(path)) score += 4;
    else if (/jobs?|careers?/.test(path)) score += 2;
    // A jobs./careers. subdomain's bare homepage IS the portal
    // (jobs.teleperformance.com, jobs.foundever.com) — it outranks
    // the /careers and /jobs guesses on the same host, which usually
    // fail the same way the homepage fetch did (Teleperformance: the
    // render went to a /careers guess that RSTs, never to the portal
    // homepage). +6, not +4: at +4 Sitel's render went to the
    // Foundever marketing homepage instead of the jobs portal — the
    // marketing copy's content score (5) beat the portal homepage
    // (4) (2026-11-12 canary). A portal homepage must clear a
    // marketing page's content score, the same lesson as the ATS
    // bonus. It now also outscores a /job-search/ path (+5) by one —
    // acceptable, because both are the same portal and the homepage
    // is the more reliable entry (a deep /job-search/ link can be a
    // stale query URL).
    const firstLabel = parsed.hostname.split('.')[0].toLowerCase();
    if ((firstLabel === 'jobs' || firstLabel === 'careers') && path === '/') score += 6;
    // A non-English locale param (locale=de_DE, lang=es) marks a
    // page that serves another country's jobs — the US portal is the
    // en variant. Foundever's render went to the de_DE variant and
    // its German banner + German search box defeated the English
    // signals. Penalize, don't forbid: a locale page can still win
    // when it is the only candidate.
    const locale =
      parsed.searchParams.get('locale') ||
      parsed.searchParams.get('lang') ||
      parsed.searchParams.get('language') ||
      '';
    const lang = locale.split(/[-_]/)[0].toLowerCase();
    if (lang && lang !== 'en') score -= 4;
    // An ATS company-list URL IS the portal (Paylocity's
    // /recruiting/jobs/All/<uuid>/<Company>): it must outrank the
    // marketing careers page that merely links to it, or the render
    // goes to a page that drifts to a register form (NexRep,
    // 2026-11-12 canary).
    if (isAtsListUrl(u)) score += 2;
  } catch {
    // Unparseable URL — scores only the careers-link bonus below.
  }
  if (careersUrl && u === careersUrl) score += 2;
  return score + atsHostBonus(u);
}

/** Signals in a fetched page's own HTML that it IS the portal — not
 *  a marketing page that merely links to one. Scored during the
 *  walk, while the HTML is already in hand. The strongest signal is
 *  the portal's own job-search input (the render step can submit it);
 *  next is an embedded job-board widget (JazzHR / Greenhouse /
 *  iSolved) the plain walk could not read; weakest is job-list markup
 *  on the page. A page that scores here becomes a render candidate
 *  even when its path says nothing about jobs — portal homepages
 *  ARE the portal (TTEC's homepage is its job search, Alorica's
 *  careers page carries a search box the render can use). Kept as a
 *  cheap regex pass over the raw HTML: no parsing, no extra fetches. */
export function portalContentScore(html: string): number {
  let score = 0;
  // A site search is not a job search: a form whose action is the
  // site root (WordPress-style /?s= search) must not credit the page
  // as a portal — Omni's corporate-careers page carries exactly such
  // a header search (action="/", placeholder "Search jobs"), and the
  // +5 put it ahead of the /join/ portal, burning a render on a
  // no-form marketing page (2026-11-12 canary). Strip those forms
  // before the input test; a job-search form submits to a results
  // endpoint, never to "/". (An empty/missing action is left alone:
  // submitting to the current URL IS the job search on a portal page.)
  const withoutSiteSearch = html.replace(
    /<form[^>]*\baction\s*=\s*["']\/["'][^>]*>[\s\S]*?<\/form\s*>/gi,
    ' ',
  );
  if (
    /<input[^>]*\b(name|id|placeholder|aria-label|class)\s*=\s*["'][^"']*(keyword|job[^"']*search|search[^"']*(job|career|position|title|role)|career[^"']*search)/i.test(
      withoutSiteSearch,
    )
  ) {
    score += 5;
  } else if (/<input[^>]*\bname\s*=\s*["']q["']/i.test(withoutSiteSearch)) {
    // A bare q input on a careers page is the job search, not a
    // site search — the careers walk only ever sees careers pages.
    score += 3;
  }
  if (jazzhrWidgetSlug(html) || greenhouseEmbedSlug(html) || isolvedIframeUrl(html)) score += 5;
  if (/job-card|jobsData|job-list|job_list|jobList/i.test(html)) score += 3;
  // Two or more links to job-detail pages: the page IS a job list,
  // even when the extractors found nothing on it (an unparsed shape
  // — the TTEC case before Strategy D). One link proves nothing (a
  // "Featured role" promo); two is a list. Fragment / mailto /
  // javascript hrefs are not links to a page.
  let detailLinks = 0;
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      if (isJobDetailUrl(new URL(href, 'https://example.com').href)) {
        detailLinks += 1;
        if (detailLinks >= 2) break;
      }
    } catch {
      // Unparseable href — not a detail link.
    }
  }
  if (detailLinks >= 2) score += 5;
  return score;
}

/** Bonus when a render candidate's hostname carries the company's
 *  own name: the company ATS subdomain is the real portal
 *  (modsquad.wd5.myworkdayjobs.com, alorica-hire.bling-ai.com),
 *  while a generic careers page on a marketing domain is the
 *  second choice. Only ranks candidates — it never creates one. */
export function companyHostBonus(u: string, companyName: string): number {
  try {
    const host = new URL(u).hostname.toLowerCase();
    const name = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!name || name.length < 3) return 0;
    for (const label of host.split('.')) {
      const clean = label.replace(/[^a-z0-9]+/g, '');
      if (clean === name) return 3;
      if (name.length >= 4 && clean.startsWith(name)) return 3;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** An ATS company-list URL: the employer's whole job list on an
 *  applicant-tracking host, not one role. Paylocity's shape is
 *  /recruiting/jobs/All/<uuid>/<Company> — the '/jobs/All/' pair is
 *  the list marker (a single role never sits under 'All'), and the
 *  same shape on any host is the same list. isJobDetailUrl misreads
 *  it as a detail (the 'jobs' segment trips its marker rule), so
 *  the render rank excluded the portal entirely and NexRep's render
 *  went to a marketing page that drifts to a register form
 *  (2026-11-12 canary). Only the list marker exempts a URL from the
 *  detail exclusion — everywhere else the exclusion stands. */
export function isAtsListUrl(rawUrl: string): boolean {
  try {
    return /\/jobs\/all(\/|$)/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

/** Path segments that are never a job list — a blog, a category
 *  index, a newsroom, a press page. They score as render targets
 *  through their page content (a WordPress front page's search box
 *  + detail links), and the render then burns on a blog while the
 *  jobs portal sits unrendered (Working Solutions: the render went
 *  to jobs.workingsolutions.com/blog/ and harvested a scam-warning
 *  post, 2026-11-12 canary). Excluded from candidacy outright — a
 *  portal is never filed under one of these. */
export function isJunkRenderPath(rawUrl: string): boolean {
  try {
    const segs = new URL(rawUrl).pathname.toLowerCase().split('/').filter(Boolean);
    return segs.some((s) =>
      /^(blog|category|categories|tag|tags|news|press|author|authors|events|event)$/.test(s),
    );
  } catch {
    return false;
  }
}

/** A URL worth rendering: the careers link the user gave, a path
 *  that names careers/jobs, or a jobs./careers. subdomain homepage.
 *  The bare homepage no longer renders on path alone — but it earns
 *  candidacy when its page content scores (portalContentScore: a
 *  job-search input or an embedded widget), because a JS homepage can
 *  BE the portal. The subdomain rule covers the fetch-failed case,
 *  where there is no page content to score: jobs.teleperformance.com
 *  IS the portal by construction, and its bare path '/' would
 *  otherwise never qualify. */
export function isCareersLikeUrl(u: string, careersUrl: string): boolean {
  if (careersUrl && u === careersUrl) return true;
  try {
    const parsed = new URL(u);
    if (/career|job/i.test(parsed.pathname)) return true;
    const firstLabel = parsed.hostname.split('.')[0] || '';
    return /^(jobs|careers)$/i.test(firstLabel);
  } catch {
    return false;
  }
}

/** A URL that IS a job list page, not a page that merely mentions a
 *  job: the user-given careers link, or a path whose segments name a
 *  listing page (/careers, /jobs, /job-search, /results, /openings).
 *  A bare homepage — even on a jobs. subdomain — is NOT list-like:
 *  it can carry a single featured role (a teaser) while the search
 *  behind it holds hundreds. Used by the walk's teaser rule: a
 *  single posting on a non-list page is remembered as a fallback
 *  while the walk continues for the real list. */
export function isListLikeUrl(u: string, careersUrl: string): boolean {
  if (careersUrl && u === careersUrl) return true;
  try {
    const parsed = new URL(u);
    const segs = parsed.pathname.toLowerCase().split('/').filter(Boolean);
    return segs.some((s) =>
      /^(careers?|jobs?|job-search|jobsearch|find-a-job|find-jobs|search-jobs|search|results|openings|positions|roles|opportunities)$/i.test(s),
    );
  } catch {
    return false;
  }
}

/** Visible text of a rendered careers page, for diagnosing what the
 *  browser actually saw: a bot challenge, an empty search state, or
 *  job titles the extractors missed. Body only, scripts and styles
 *  stripped, collapsed to a short sample — the page's own public
 *  text, never anything private. */
export function sampleRenderedText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export async function searchCompanyJobs(
  company: CompanySearchInput,
  resumeText: string,
  opts: SearchCompanyOpts = {},
): Promise<CompanySearchResult> {
  const careersUrl = company.careersUrl || '';
  const website = company.website || '';
  const triedUrls: string[] = [];
  // Only pages on the business site are ever fetched: a careers link
  // the user gave (it names the company's own careers page), plus the
  // website's homepage, its nav-linked careers pages, and the /careers
  // and /jobs guesses. A board link — pasted or found on a page — is
  // never followed as a source.
  const candidates: string[] = [];
  if (careersUrl && !isBoardUrl(careersUrl)) candidates.push(careersUrl);
  if (website && !isBoardUrl(website)) {
    const base = website.replace(/\/$/, '');
    for (const u of [website, `${base}/careers`, `${base}/jobs`]) {
      if (!candidates.includes(u)) candidates.push(u);
    }
    // Jobs-subdomain website (jobs.teleperformance.com): when the
    // subdomain fails outright, the apex homepage is the only other
    // fetchable page on the business's own domain — its nav is the
    // route to the portal (possibly on a different host).
    try {
      const host = new URL(website).hostname.toLowerCase();
      if (/^(jobs|careers)\./.test(host)) {
        const apex = `https://${host.split('.').slice(1).join('.')}`;
        if (!candidates.includes(apex) && !isBoardUrl(apex)) candidates.push(apex);
      }
    } catch {
      // Unparseable website — no apex to add.
    }
  }
  const renderBudget = opts.renderBudget ?? { used: 0, max: 2 };
  const renderDeadlineMs = opts.renderDeadlineMs ?? Date.now() + RENDER_WINDOW_MS;
  let anyFetchOk = false;
  let renderUsed = false;
  let renderAttempted = false;
  let renderMs = 0;
  let renderError: string | null = null;
  let renderTextSample = '';
  let searchOutcome: PortalSearchOutcome | null = null;
  let searchScan: SearchScanSummary | null = null;
  let searchMs = 0;
  let renderedUrl = '';
  let renderAttempts: {
    target: string;
    ms: number;
    outcome: PortalSearchOutcome | null;
    error: string | null;
    renderedUrl: string;
    cookieClicks: number;
    bannerPresent: boolean;
    bannerButtons: string[];
    cookieClickedLabel: string | null;
    bannerVisible: boolean;
    searchToggleClicked: string | null;
    searchCountryClicked: string | null;
    searchGateClicked: string | null;
  }[] = [];
  let renderTargets: { url: string; score: number }[] = [];
  // A single posting on a non-list page, remembered while the walk
  // continues for the real list — a teaser, not the list
  // (Teleperformance's homepage carries one featured role while the
  // real portal holds hundreds, 2026-11-12 canary). Returned only
  // when neither the walk nor the render finds a real list.
  let fallbackPostings: { postings: Posting[]; url: string } | null = null;
  // A rendered page whose postings all die as no-match, remembered
  // the same way — the render loop no longer returns such a page as
  // "the list" (it continues to the next target), and these postings
  // come back if every target is junk. Only set when the walk
  // remembered nothing: a walk teaser is a real lead, and it wins
  // over a rendered page's junk.
  let renderFallback: { postings: Posting[]; url: string } | null = null;
  // Deferred rendering: the plain-HTML walk runs FIRST and the render
  // fires only after it, on the single most promising zero-yielding
  // candidate. Rendering the first zero-yielding candidate mid-walk
  // spends the one-per-company budget on whatever the walk hits first
  // — often an FAQ/culture page with no search box — before the page
  // that actually carries the portal (a /job-search/ link on that
  // same FAQ page) is ever discovered. The walk also finds
  // plain-HTML postings on later candidates without spending any
  // render budget at all. Candidates carry a precomputed score
  // (path + page-content signals + company-host bonus, see
  // portalContentScore / companyHostBonus); a fetch-failed
  // careers-like URL still scores on path alone, because a WAF that
  // rejects the plain fetch may still serve the real browser.
  interface RenderCandidate {
    url: string;
    score: number;
  }
  // Pages the walk already fetched and parsed postings from.
  // Re-rendering one is low-value — the walk proved its SSR
  // content — so it ranks below an unread page. Without the
  // penalty Teleperformance's marketing pages score 15 (search
  // input + job-list markers + detail links) and outrank the
  // fetch-failed jobs homepage (9), so both render attempts burn
  // on marketing pages and the portal is never reached
  // (2026-11-12 round-6 canary). A page the walk read with ZERO
  // postings is NOT penalized: its listings may be JS-only, and
  // the render is how they surface (ModSquad's Workday shell).
  const readWithPostings = new Set<string>();
  const zeroYieldTargets: RenderCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i];
    triedUrls.push(u);
    let html: string;
    try {
      html = await fetchText(u);
      anyFetchOk = true;
    } catch {
      // A fetch-failed candidate is still renderable when it is
      // careers-like by path/host — or an ATS portal by host: a
      // Workday URL (/en-US/ModSquad) has no job word in its path and
      // no content to score, so without the host rule it never
      // becomes a render candidate at all (ModSquad, 2026-11-12).
      if (isCareersLikeUrl(u, careersUrl) || atsHostBonus(u) > 0) {
        // A job-detail URL is one role, not a list — rendering it
        // shows that role alone, never the portal, so it must not
        // spend render budget: NexRep's board page links 3 detail
        // URLs and they outranked the /careers guess, burning both
        // renders on detail pages (2026-11-12 local round). The
        // plain-HTML fetch already captured the role as a teaser
        // fallback; only the render rank is lost, not the role. An
        // ATS company-list URL is the exception: it looks like a
        // detail to isJobDetailUrl but it IS the list (NexRep's
        // Paylocity portal, 2026-11-12 canary). A blog/category path
        // is never a target either (Working Solutions).
        if ((!isJobDetailUrl(u) || isAtsListUrl(u)) && !isJunkRenderPath(u)) {
          // Score on path AND host, like the fetched branch: a
          // jobs./careers. subdomain homepage scores 0 on path alone,
          // so without the host bonus it would always lose to the
          // /careers and /jobs guesses (2 each) — and the render would
          // go to a guess that fails the same way instead of the portal.
          zeroYieldTargets.push({
            url: u,
            score: renderTargetScore(u, careersUrl) + companyHostBonus(u, company.name),
          });
        }
      }
      continue;
    }
    const pagePostings = await collectPagePostings(html, u, false);
    if (pagePostings.length > 0) {
      // A single posting is a teaser, not the list — UNLESS it is
      // the whole list. The old rule trusted isListLikeUrl alone,
      // but a teaser CAN live on a list-like path: Teleperformance's
      // /en-us/careers/job-opportunities/ carries one featured role
      // ("Jamaica") while the portal behind it holds hundreds, and
      // the segment test ('careers', 'opportunities') called it a
      // list — so the walk returned the teaser at once and the render
      // never ran (2026-11-12 canary). The tie-breaker is whether the
      // walk already found a zero-yield render target: the portal
      // the teaser points at (Teleperformance's jobs-subdomain
      // homepage, fetch-failed and already a candidate when the
      // teaser page is reached). A genuine one-job list page has no
      // such target — its single posting returns at once, unrendered,
      // as before (Static Co's /careers keeps its 'html' source and
      // costs no render budget). Two or more postings IS the list —
      // return it at once, as before. The teaser page stays eligible
      // as a render target below, and its links are still discovered.
      const isTeaser =
        pagePostings.length === 1 && (!isListLikeUrl(u, careersUrl) || zeroYieldTargets.length > 0);
      if (isTeaser) {
        if (!fallbackPostings) fallbackPostings = { postings: pagePostings, url: u };
      } else {
        // Only a page treated as the list earns the -10 re-render
        // penalty below: its SSR content is proven. A teaser page
        // (one posting on a non-list page) is exactly a page whose
        // real list may be JS-only — penalizing it pushed Working
        // Solutions' jobs homepage below its own blog pages
        // (2026-11-12 canary) and the render went to the blog.
        readWithPostings.add(u);
        const screened = screenPostings(company.name, pagePostings, resumeText, company.isUSCompany ?? false);
        // A page whose postings ALL die as no-match is not the list
        // — either the extractor misread the page (Teleperformance's
        // values page: two junk "postings", 2026-11-12 canary) or the
        // roles genuinely don't match. Either way the render deserves
        // its chance, and the remembered postings come back as the
        // fallback if it finds nothing. A page with a lead — or a
        // real role rejected only on location (TTEC's Athens roles) —
        // IS the list: return it at once, as before.
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
              rejected: screened.rejected,
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
            renderTargets,
          };
        }
      }
    }
    // Zero REAL postings — the page stays eligible for the render.
    // A page that carries the portal's search box or a job-board
    // widget is a candidate even when its path says nothing about
    // jobs: portal homepages ARE the portal (TTEC's homepage is its
    // job search; the old rule never rendered a bare homepage). An
    // ATS host is portal-like by construction, too — a Workday shell
    // carries no searchable content in its raw HTML.
    const contentScore = portalContentScore(html);
    // A job-detail URL is one role, not a list (same rule as the
    // fetch-failed branch above): rendering it shows that role
    // alone, never the portal, so it must not spend render budget.
    // The plain-HTML fetch already captured the role as a teaser
    // fallback; only the render rank is lost, not the role.
    if (
      (contentScore > 0 || isCareersLikeUrl(u, careersUrl) || atsHostBonus(u) > 0) &&
      (!isJobDetailUrl(u) || isAtsListUrl(u)) &&
      !isJunkRenderPath(u)
    ) {
      zeroYieldTargets.push({
        url: u,
        score:
          renderTargetScore(u, careersUrl) +
          contentScore +
          companyHostBonus(u, company.name) -
          (readWithPostings.has(u) ? 10 : 0),
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
  // The walk found nothing in plain HTML. Render the best target,
  // while budget and deadline last — and RETRY the next-best target
  // when the render dies or the portal search finds no form: the
  // best-scored target is not always the portal (Sitel's render went
  // to the Foundever marketing homepage; Teleperformance's went to a
  // /careers guess that RSTs), and a no-form render on the wrong page
  // must not spend the whole budget. Any other outcome stops the
  // loop: the search ran on the best target, so a different page is
  // unlikely to do better. A failed render just leaves the company
  // at zero listings — the outcome fields still say what happened.
  if (zeroYieldTargets.length > 0 && opts.renderPage) {
    // Best score first; the sort is stable, so ties keep walk order
    // (the user-given careers link first).
    const targets = [...zeroYieldTargets].sort((a, b) => b.score - a.score);
    renderTargets = targets.map((t) => ({ url: t.url, score: t.score }));
    for (const { url: target } of targets) {
      if (renderBudget.used >= renderBudget.max || Date.now() >= renderDeadlineMs) break;
      // A render that dies FAST (under 5s, no HTML — a host that
      // resets the connection, a launch failure) is not a real
      // attempt: it is retried once on the SAME target without
      // consuming budget, and a fast death never consumes budget at
      // all — so a transport failure on the best target cannot
      // strand the company before the next-best target is tried
      // (Teleperformance: jobs.teleperformance.com RSTs the render
      // in ~180ms, 2026-11-12 canary; the loop then spent its two
      // charged attempts on the portal and the apex homepage and
      // never reached the careers job-opportunities page). A slow
      // failure (a 20s navigation timeout) still consumes budget:
      // it did the work of a real attempt. A board redirect is not
      // a failure to retry — the target really is a board.
      let rendered: RenderPageResult | null = null;
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
        let attemptRendered: RenderPageResult | null = null;
        try {
          attemptRendered = await opts.renderPage(target, portalSearchTerm(resumeText));
        } catch {
          attemptRendered = null;
        }
        attemptMs = Date.now() - started;
        renderMs += attemptMs;
        // Record every attempt — including a null render (the renderer
        // died or the call threw): without this the live canary cannot
        // tell a retry that never ran from a retry that failed.
        renderAttempts.push({
          target,
          ms: attemptMs,
          outcome: attemptRendered?.searchOutcome ?? null,
          error: attemptRendered ? (attemptRendered.renderError ?? null) : 'render-null',
          renderedUrl: attemptRendered?.renderedUrl ?? '',
          cookieClicks: attemptRendered?.cookieClicks ?? 0,
          bannerPresent: attemptRendered?.bannerPresent ?? false,
          bannerButtons: attemptRendered?.bannerButtons ?? [],
          cookieClickedLabel: attemptRendered?.cookieClickedLabel ?? null,
          bannerVisible: attemptRendered?.bannerVisible ?? false,
          searchToggleClicked: attemptRendered?.searchToggleClicked ?? null,
          searchCountryClicked: attemptRendered?.searchCountryClicked ?? null,
          searchGateClicked: attemptRendered?.searchGateClicked ?? null,
        });
        rendered = attemptRendered;
        // A FAST failure is a transport death, not a rendered page
        // that found nothing: a no-form / no-results render carries
        // an outcome (and usually HTML), so an empty-HTML no-form
        // must NOT retry for free — the old "no HTML" test retried
        // it on the same target instead of moving to the next one
        // (testRenderRetry, 2026-11-12). Only a renderError, a null
        // outcome, or a null render counts as died-fast.
        const failedFast =
          !attemptRendered?.html &&
          (attemptRendered?.renderError || attemptRendered?.searchOutcome == null) &&
          attemptMs < 5000;
        if (attemptNo === 0 && failedFast) {
          // The attempt died fast — refund its budget and retry the
          // same target once. A null render (the renderer threw)
          // counts the same way: it carries no HTML either.
          renderBudget.used -= 1;
          continue;
        }
        break;
      }
      if (!rendered) {
        // The renderer died before returning anything — the next
        // target may still load (a host that RSTs one path may serve
        // another). No outcome to record, so the loop continues.
        continue;
      }
      searchOutcome = rendered.searchOutcome;
      searchScan = rendered.searchScan ?? null;
      searchMs = rendered.searchMs;
      renderedUrl = rendered.renderedUrl;
      renderError = rendered.renderError ?? null;
      if (rendered.html) {
        renderTextSample = sampleRenderedText(rendered.html);
        // Resolve the rendered page's links against the URL the
        // render actually ended on — a search can navigate the page
        // to a results URL, and relative links belong to that page.
        const pagePostings = await collectPagePostings(
          rendered.html,
          rendered.renderedUrl || target,
          true,
        );
        if (pagePostings.length > 0) {
          renderUsed = true;
          const screened = screenPostings(company.name, pagePostings, resumeText, company.isUSCompany ?? false);
          // The walk's rule, mirrored here: a rendered page whose
          // postings ALL die as no-match is not the list either
          // (Teleperformance's values page scores 10 as a render
          // target — its job-list markers + two detail links outrank
          // the jobs homepage at 6 — and the loop used to return it
          // at once). Remember it as the render fallback and try
          // the next target; a page with a lead, or a real role
          // rejected only on location, still returns at once.
          // EXCEPT when the page reported 'has-listings': its own
          // results-count line says listings ARE on it, and the
          // roles on it are the company's roles — trying the next
          // target only re-reads a different page (NexRep: the
          // careers page after the Paylocity list, whose gate drifts
          // to a register form, 2026-11-12 canary). A marketing /
          // teaser page never reports 'has-listings' (no
          // results-count line — TP's values page reported
          // 'no-form', same canary), so the fallback-and-continue
          // rule still applies to every other outcome. Stopping here
          // also saves the second render.
          if (screened.leads.length === 0 && screened.rejectedLocation === 0) {
            if (!fallbackPostings && !renderFallback) renderFallback = { postings: pagePostings, url: target };
            if (searchOutcome === 'has-listings') break;
            continue;
          }
          return {
            // Stamp the search flag: these listings came out of a
            // portal search submit, not the plain walk.
            leads: screened.leads.map((l) => ({ ...l, searched: searchOutcome === 'searched' })),
            postingsSeen: pagePostings.length,
            sourcePage: target,
            triedUrls,
            fetchOk: true,
            screened: {
              rejectedNoMatch: screened.rejectedNoMatch,
              rejectedLocation: screened.rejectedLocation,
              reviewLocation: screened.reviewLocation,
              rejected: screened.rejected,
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
            renderTargets,
          };
        }
      }
      // Retryable: the render failed outright, or the portal search
      // found no box on this page — try the next-best target. Any
      // other outcome (searched, no-results, has-listings with an
      // unparsed shape, submit-failed, board-redirect) means the
      // search ran on the best target; stop.
      const failedRender = !rendered.html && (renderError !== null || searchOutcome === null);
      if (failedRender || searchOutcome === 'no-form') continue;
      break;
    }
  }
  // Neither the walk nor the render found a real list — fall back
  // to the remembered postings (a walk teaser, a real posting just
  // not the list, wins over a rendered page's junk; a rendered
  // page's all-rejected postings come back only when the walk
  // remembered nothing). It beats returning nothing: a company with
  // one featured role and a portal the render could not read still
  // surfaces its role. Only reached when no list page and no render
  // yielded postings.
  const fb = fallbackPostings ?? renderFallback;
  if (fb) {
    const screened = screenPostings(company.name, fb.postings, resumeText, company.isUSCompany ?? false);
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
        rejected: screened.rejected,
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
      renderTargets,
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
    renderTargets,
  };
}

/** The highest years-of-experience figure a text states, or null.
 *  Only counts years tied to experience/requirements ("8+ years of
 *  experience", "minimum 5 years", "10 years in React") — not stray
 *  mentions like "founded 5 years ago". */
function extractYears(text: string): number | null {
  let max: number | null = null;
  const take = (n: number) => {
    if (n >= 1 && n <= 50 && (max === null || n > max)) max = n;
  };
  for (const m of text.matchAll(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience/gi)) take(+m[1]);
  for (const m of text.matchAll(/(?:experience|required|minimum|at least)[^.\n]{0,50}?(\d+)\+?\s*(?:years?|yrs?)\b/gi)) take(+m[1]);
  for (const m of text.matchAll(/(\d+)\+?\s*(?:years?|yrs?)\s+(?:in|of|with)\b/gi)) take(+m[1]);
  return max;
}

/** Explicit skill requirements a posting states ("experience with
 *  Angular", "must have AWS") that the resume doesn't show. Parsed
 *  from requirement phrases, not a fixed skill list — so it works for
 *  any field, not just frontend. Capped at 3. */
function extractRequiredSkills(description: string, resumeSet: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const triggers =
    /(?:experience with|experience in|experience using|proficiency in|proficiency with|knowledge of|skilled in|expertise in|familiarity with|must have)\s+([A-Za-z][A-Za-z0-9+#./&\- ]{1,60}?)(?:,|;|\.|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = triggers.exec(description)) !== null && out.length < 3) {
    for (const raw of m[1].split(/\s+and\s+|\s+or\s+|,/)) {
      let piece = raw.trim().replace(/\s+(experience|required|preferred|skills?)$/i, '').trim();
      if (!piece || piece.split(/\s+/).length > 3) continue;
      const key = piece.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Shown only if none of its words appear in the resume.
      if (tokenize(piece).every((t) => resumeSet.has(t))) continue;
      out.push(piece);
      if (out.length >= 3) break;
    }
  }
  return out;
}

export interface ScreenedPostings {
  leads: FinderLead[];
  rejectedNoMatch: number;
  rejectedLocation: number;
  reviewLocation: number;
  /** Why postings were dropped (title + location + reason, capped at
   *  10): without it a "4 postings, 0 leads" result cannot say whether
   *  the roles were wrong or the matcher was — NexRep, 2026-11-12. */
  rejected: { title: string; location: string; reason: 'no-match' | 'location' }[];
}

/** Literal title words that name CS work. LITERAL only — the gate
 *  must never use synonym-credited terms: the ['agent',
 *  'representative', 'specialist'] group let any 'Specialist' title
 *  credit 'agent', and 'agent' was in the old function set, so 'Staff
 *  Lidar Technical Specialist' passed the gate with strengths 'Agent
 *  (via Specialist)'. 'patient'/'guest'/'billing' join the list Eric
 *  gave (service/support/customer/client/member/help/call): his CS
 *  definition covers Member/Patient/Guest Service, and billing is the
 *  core of his resume — without them 'Patient Access Representative'
 *  and 'Billing Specialist' would be rejected. */
const CS_FUNCTION_WORDS = new Set([
  'service',
  'support',
  'customer',
  'client',
  'member',
  'patient',
  'guest',
  'help',
  'call',
  'billing',
]);

/** Words that make a generic 'specialist'/'technician' title a CS
 *  role: the title must name who is served, or the kind of support.
 *  'service' is deliberately absent — 'Field Service Technician'
 *  would otherwise pass on 'service' alone, which is exactly the
 *  failure the Nov 11 re-run exposed (its strengths were 'Service' +
 *  'Technical (via Technician)'). 'specialist'/'technician' are the
 *  only role words this qualifier applies to; representative, agent,
 *  coordinator and the rest count on their own. */
const CS_ROLE_QUALIFIERS = new Set([
  'customer',
  'client',
  'member',
  'patient',
  'guest',
  'support',
  'help',
  'call',
  'billing',
]);

const ROLE_WORDS = new Set([
  'representative',
  'agent',
  'specialist',
  'manager',
  'coordinator',
  'associate',
  'technician',
  'analyst',
  'clerk',
  'supervisor',
  // 'support' IS the role: 'Customer Service Support', 'Technical
  // Customer Support' and 'Phone Support' name no other role word,
  // so without it the gate rejects real CS roles outright (ModSquad,
  // 2026-11-12 canary: all three died as no-match). The score
  // formula still holds the 60 line — a bare 'Sales Support' matches
  // one resume term and scores 55, a near-miss, never an auto-add.
  'support',
  'assistant',
  'advisor',
  'consultant',
  'engineer',
  'developer',
  'designer',
  'director',
  'lead',
  'intern',
  'trainer',
  'advocate',
  'liaison',
  'officer',
  'aide',
  'worker',
  'counselor',
  'operator',
  'attendant',
  'nurse',
  'teacher',
  // 'expert' IS the role at iCIMS-style boards: Teleperformance titles
  // its reps 'Customer Service Expert' / 'Customer Expert' — without
  // it the gate rejects a real CS role outright (2026-11-12 probe).
  // The gate still requires a literal CS word, and the score still
  // holds the 60 line (a bare 'Customer Expert' matches one resume
  // term and scores 55, a near-miss).
  'expert',
]);

/** Score postings against the resume. A posting is scored when at
 *  least one resume term matches (exact or synonym) in its title or
 *  description — the floor, not a gate. The score formula is unchanged:
 *  50 + 50 × overlap, where overlap is the ratio of matched resume
 *  terms to min(terms, 10), capped at 100. A single match lands in the
 *  mid-50s (near miss); auto-add at 60+ still needs real overlap, so
 *  the score — not the floor — is the precision gate. Location is
 *  classified before scoring: hard rejects drop out, uncertain
 *  locations become review-only leads. Customer-service resumes get
 *  one more check (see the title gate inside): the title itself must
 *  name CS work and a role, because description-only matches let a
 *  faculty posting's JD ('phone... policy... service') score 85 while
 *  real CS titles sat at 55. */
export function screenPostings(
  company: string,
  postings: Posting[],
  resumeText: string,
  isUSCompany: boolean = false,
): ScreenedPostings {
  const resumeTerms = extractResumeTerms(resumeText);
  const resumeSet = new Set(resumeTerms);
  const resumeYears = extractYears(resumeText);
  const leads: FinderLead[] = [];
  let rejectedNoMatch = 0;
  let rejectedLocation = 0;
  let reviewLocation = 0;
  const rejected: { title: string; location: string; reason: 'no-match' | 'location' }[] = [];
  const noteRejected = (p: Posting, reason: 'no-match' | 'location'): void => {
    if (rejected.length < 10) rejected.push({ title: p.title, location: p.location || '', reason });
  };
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
  // A customer-service resume claims both 'customer' and 'service';
  // a frontend resume claims neither, so this gate only ever applies
  // to CS resumes and can never touch another field's matching.
  const isCsResume = resumeSet.has('customer') && resumeSet.has('service');
  for (const p of postings) {
    const postingWords = new Set(tokenize(`${p.title} ${p.description}`));
    const matches = matchResumeTerms(postingWords, resumeTerms);
    if (matches.length === 0 || !matches.some((m) => !m.ambiguousOnly)) {
      rejectedNoMatch += 1;
      noteRejected(p, 'no-match');
      continue;
    }
    if (isCsResume) {
      const titleWords = new Set(tokenize(p.title));
      // Literal words only: namesCsWork must see the word itself in
      // the title. The old check used synonym-credited terms, so a
      // 'Specialist' title credited 'agent' and passed as CS work.
      const namesCsWork = [...titleWords].some((w) => CS_FUNCTION_WORDS.has(w));
      // A 'specialist'/'technician' title is only a CS role when the
      // title also names who is served ('Customer Service Specialist'
      // keeps passing; 'Field Service Technician' and 'Lab Safety
      // Specialist' do not). Every other role word counts on its own.
      const namesRole = [...titleWords].some((w) => {
        if (!ROLE_WORDS.has(w)) return false;
        if (w === 'specialist' || w === 'technician') {
          return [...titleWords].some((q) => CS_ROLE_QUALIFIERS.has(q));
        }
        return true;
      });
      if (!namesCsWork || !namesRole) {
        rejectedNoMatch += 1;
        noteRejected(p, 'no-match');
        continue;
      }
    }
    const loc = locationVerdict(p.location, `${p.title} ${p.description}`, isUSCompany);
    if (loc.verdict === 'reject') {
      rejectedLocation += 1;
      noteRejected(p, 'location');
      continue;
    }
    const needsReview = loc.verdict === 'review';
    if (needsReview) reviewLocation += 1;
    const overlap = resumeTerms.length === 0 ? 0 : matches.length / Math.min(resumeTerms.length, 10);
    // Capped at 100: a rich description can match more than 10 resume
    // terms, and a score above 100 reads as broken.
    const matchScore = Math.min(100, Math.round(50 + 50 * overlap));
    // Gaps: the posting description's most frequent terms the resume
    // doesn't mention — what the posting wants that the resume lacks.
    // Group-aware: a description word counts as shown when the resume
    // has it or any group mate ('engineer' is not a gap for a
    // 'developer' resume). Never used to invent a skill — only to flag.
    const descCounts = new Map<string, number>();
    for (const t of tokenize(p.description)) {
      if (resumeSet.has(t)) continue;
      if (groupMates(t).some((m) => resumeSet.has(m))) continue;
      descCounts.set(t, (descCounts.get(t) ?? 0) + 1);
    }
    const gaps = [...descCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([t]) => t);
    if (/staff|principal/.test(p.title.toLowerCase())) gaps.unshift('Staff/principal-level ask');
    // Why this job may not fit, in plain words — the years bar vs
    // what the resume shows, then explicit skill requirements missing
    // from the resume. A related job with a low score should say why.
    const reasons: string[] = [];
    const postingYears = extractYears(`${p.title} ${p.description}`);
    if (postingYears !== null && (resumeYears === null || postingYears > resumeYears)) {
      reasons.push(
        resumeYears === null
          ? `Asks ${postingYears}+ years of experience — your resume doesn't state a years figure`
          : `Asks ${postingYears}+ years of experience, your resume shows ${resumeYears}`,
      );
    }
    for (const skill of extractRequiredSkills(p.description, resumeSet)) {
      reasons.push(`Requires ${skill} — not shown in your resume`);
    }
    leads.push({
      company,
      title: p.title,
      location: p.location,
      locationFlag: loc.flag,
      salaryText: parsePay(p.description),
      applyUrl: p.url,
      description: p.description.slice(0, 2000),
      postedDate: p.postedDate,
      matchScore,
      // Provenance: an expanded match names the posting word it came
      // through, so a 'Developer (via Engineer)' strength can be
      // audited instead of trusted.
      strengths: matches.slice(0, 6).map((m) => (m.exact ? cap(m.term) : `${cap(m.term)} (via ${cap(m.via)})`)),
      gaps,
      reasons,
      needsReview,
      sourceType: p.source ?? 'html',
    });
  }
  return { leads, rejectedNoMatch, rejectedLocation, reviewLocation, rejected };
}

/* ------------------------------------------------------------------ */
/* Server auto-add (sweep path)                                        */
/* ------------------------------------------------------------------ */

/** Board dedupe + tailored-file helpers — mirrors src/domain/index.ts
 *  (jobDedupeKey / deriveTailoredFileName). KEEP IN SYNC: the UI's
 *  client-side auto-add uses the domain copies; the server cannot
 *  import the frontend bundle, so these live here too. */
function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jobDedupeKey(title: string, company: string): string {
  return `${normalizeKey(title)}|${normalizeKey(company)}`;
}

function deriveTailoredFileName(company: string): string {
  const clean = (company ?? '').trim().replace(/[\\/:*?"<>|]/g, '').trim();
  return clean ? `Eric_${clean}_Resume` : 'Eric_Resume';
}

function newJobId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AutoAddedLead {
  title: string;
  company: string;
  matchScore: number;
}

/** Append qualifying leads to the board (the state doc's jobs array),
 *  in the exact shape the UI's addJob creates. Only leads at 60%+
 *  with a confirmed US-remote location qualify — needsReview leads
 *  never auto-add, whatever the score, and neither do sub-60 leads.
 *  Dedupe is by title+company against the board AND within the batch.
 *  The write is guarded by the state doc's updatedAt (optimistic
 *  concurrency): if another writer moved the doc between the read and
 *  the write, the update matches nothing and the whole step retries
 *  from a fresh read (up to 3 attempts) instead of clobbering. A
 *  chunk whose leads are all already on the board costs one read and
 *  no write. */
export async function autoAddLeadsToBoard(
  appStateCol: Collection<any>,
  leads: FinderLead[],
  resumeLabel: string,
): Promise<{ added: number; addedLeads: AutoAddedLead[] }> {
  const qualifying = leads.filter((l) => l.matchScore >= 60 && !l.needsReview);
  if (qualifying.length === 0 || !resumeLabel) return { added: 0, addedLeads: [] };
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await appStateCol.findOne({ _id: 'jobboard' } as never);
    if (!doc || !doc.state || !Array.isArray(doc.state.jobs)) return { added: 0, addedLeads: [] };
    const existing = new Set<string>(
      (doc.state.jobs as any[]).map((j) => jobDedupeKey(j.title ?? '', j.company ?? '')),
    );
    const seen = new Set<string>();
    const fresh = qualifying.filter((l) => {
      const k = jobDedupeKey(l.title, l.company);
      if (existing.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length === 0) return { added: 0, addedLeads: [] };
    const newJobs = fresh.map((l) => ({
      id: newJobId(),
      title: l.title,
      company: l.company,
      location: l.location,
      salaryText: l.salaryText || '',
      source: 'Career Page',
      postedDate: l.postedDate || '',
      applyUrl: l.applyUrl,
      description: l.description || '',
      matchScore: l.matchScore,
      strengths: l.strengths ?? [],
      gaps: l.gaps ?? [],
      masterResumeName: resumeLabel,
      tailoredResumeText: '',
      tailoredFileName: deriveTailoredFileName(l.company),
      stageId: 'new',
      notes: 'Found via Finder.',
      activities: [],
      createdAt: now,
      updatedAt: now,
    }));
    const nextState = { ...doc.state, jobs: [...(doc.state.jobs as any[]), ...newJobs] };
    const res = await appStateCol.updateOne(
      { _id: 'jobboard', updatedAt: doc.updatedAt } as never,
      { $set: { state: nextState, updatedAt: new Date() } },
      {},
    );
    if (res.matchedCount === 1) {
      return {
        added: newJobs.length,
        addedLeads: newJobs.map((j) => ({ title: j.title, company: j.company, matchScore: j.matchScore })),
      };
    }
    // matchedCount 0: another writer moved the doc — re-read and retry.
  }
  return { added: 0, addedLeads: [] };
}

/* ------------------------------------------------------------------ */
/* Collection paging (the user's own company database)                 */
/* ------------------------------------------------------------------ */

export interface FindJobsDeps {
  companiesCol: Collection<CompanyDoc>;
  /** The app-state collection (dealboard.app_state) — only used when
   *  the caller passes autoAdd: true. The UI flow never passes it. */
  appStateCol?: Collection<any>;
}

export interface FindJobsResult {
  leads: FinderLead[];
  checked: number;
  totalCompanies: number;
  nextCursor: number | null;
  done: boolean;
  /** Leads appended to the board by this call (server auto-add only;
   *  0 unless the caller passed autoAdd: true). */
  autoAdded: number;
  /** The leads that landed on the board, so a headless caller can
   *  report exactly what was added without re-reading state. */
  autoAddedLeads: AutoAddedLead[];
  stats: {
    postingsSeen: number;
    boardErrors: number;
    noBoard: number;
    /** No candidate page loaded at all (all fetches failed). */
    unreachable: number;
    /** Pages loaded but carried zero listings. */
    noListings: number;
    /** Postings dropped: no resume-term match / location reject. */
    rejectedNoMatch: number;
    rejectedLocation: number;
    /** Leads kept as review-only (uncertain location). */
    reviewLocation: number;
    /** Companies whose listings came from the render fallback. */
    rendered: number;
    /** Renders attempted in this chunk (a render that found nothing
     *  still counts — rendered above counts only renders that
     *  produced postings, so the two together prove whether the
     *  render step actually fired). */
    renderAttempts: number;
    /** Total milliseconds spent rendering in this chunk. */
    renderMs: number;
    /** Portal-search outcomes across the chunk, one counter per
     *  render-search outcome value (has-listings / searched /
     *  no-form / submit-failed / no-results / board-redirect /
     *  skipped-time) plus the total search milliseconds. FLAT
     *  NUMBERS only: the sweep client sums stats values generically,
     *  so a nested object here would be dropped. These prove the
     *  search step fired and what it returned — v4 could not
     *  quantify it at all. */
    searchHasListings: number;
    searchSearched: number;
    searchNoForm: number;
    searchSubmitFailed: number;
    searchNoResults: number;
    searchBoardRedirect: number;
    searchSkippedTime: number;
    /** Total milliseconds spent inside the portal search step. */
    searchMs: number;
    /** Leads appended to the board by this call (server auto-add
     *  only; 0 for plain UI calls). Flat like the rest of stats so
     *  the sweep client can sum it. */
    autoAdded: number;
  };
}

export async function runFindJobs(
  deps: FindJobsDeps,
  body: { resumeText?: string; cursor?: number; limit?: number; autoAdd?: boolean; resumeLabel?: string },
  opts: { renderPage?: RenderPageFn | null } = {},
): Promise<FindJobsResult> {
  const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
  const cursorRaw = Number(body.cursor ?? 0);
  const limitRaw = Number(body.limit ?? 15);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? Math.floor(cursorRaw) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : 15;

  // The server pages its own companies collection (insertion order) —
  // the client never sends names, and no seed fallback exists. A company
  // not in the collection is simply not searched.
  const total = await deps.companiesCol.countDocuments();
  const slice = await deps.companiesCol
    .find({})
    .sort({ _id: 1 } as never)
    .skip(cursor)
    .limit(limit)
    .toArray();

  const startedAt = Date.now();
  const leads: FinderLead[] = [];
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
  // One render budget shared by the whole chunk, and one start
  // deadline: renders only begin in the first 30s so a slow page can
  // never push the invocation past its 60s maxDuration.
  const renderBudget = { used: 0, max: MAX_RENDERS_PER_CALL };
  const renderDeadlineMs = startedAt + RENDER_WINDOW_MS;

  async function processCompany(company: CompanyDoc): Promise<FinderLead[]> {
    // Every roster company is a U.S. company by construction: Find
    // Companies only admits Wikidata rows with country or HQ in the
    // United States (P17 = Q30), SEC EDGAR registrants, and the U.S.
    // seed list. The one exception is a manually added company
    // (source 'Manual') — its country is not known, so it keeps the
    // old review behavior for unstated locations.
    const result = await searchCompanyJobs(
      { name: company.name, website: company.website || '', careersUrl: company.careersUrl || '', isUSCompany: company.source !== 'Manual' },
      resumeText,
      { renderPage: opts.renderPage ?? null, renderBudget, renderDeadlineMs },
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
    // Search telemetry: one flat counter per outcome value, so the
    // next sweep can prove how often the portal search fired and
    // what it returned (v4: unquantifiable).
    if (result.searchOutcome) {
      searchMsTotal += result.searchMs;
      switch (result.searchOutcome) {
        case 'has-listings':
          searchHasListings += 1;
          break;
        case 'searched':
          searchSearched += 1;
          break;
        case 'no-form':
          searchNoForm += 1;
          break;
        case 'submit-failed':
          searchSubmitFailed += 1;
          break;
        case 'no-results':
          searchNoResults += 1;
          break;
        case 'board-redirect':
          searchBoardRedirect += 1;
          break;
        case 'skipped-time':
          searchSkippedTime += 1;
          break;
      }
    }
    return result.leads;
  }

  // Small worker pool: 5 companies at a time, soft deadline so the
  // function never blows the serverless time limit mid-chunk. The cursor
  // only advances past the contiguous run of finished companies, so a
  // company cut off by the deadline is retried — never skipped — and the
  // client dedupes any lead returned twice.
  let next = 0;
  const completed = new Set<number>();
  async function worker(): Promise<void> {
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

  // Opt-in server auto-add (sweep path): qualifying leads land on the
  // board as they are found, so a headless caller that never touches
  // the UI still fills the Pipeline. The UI Find Jobs flow does its
  // own client-side auto-add and does NOT pass autoAdd — the server
  // never writes during a UI run, so the two paths cannot duplicate
  // or clobber each other.
  let autoAdded = 0;
  let autoAddedLeads: AutoAddedLead[] = [];
  if (
    body.autoAdd === true &&
    typeof body.resumeLabel === 'string' &&
    body.resumeLabel.length > 0 &&
    deps.appStateCol
  ) {
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
      autoAdded,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

/* The render fallback needs the full Hobby allowance: a cold render
 * (binary download + launch + page JS) can take ~30s, so the function
 * runs with maxDuration 60 (the Hobby cap). The 50s soft deadline
 * inside runFindJobs still bounds normal chunk work. */
export const config = { maxDuration: 60 };

async function handlerInner(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const body = req.body ?? {};
  const result = await runFindJobs(
    {
      companiesCol: await getCompaniesCollection(),
      // The board write needs the state collection only when the
      // caller asked for server auto-add; the UI path never passes
      // autoAdd and never pays for the extra handle.
      appStateCol: body.autoAdd === true ? await getAppStateCollection() : undefined,
    },
    { resumeText: body.resumeText, cursor: body.cursor, limit: body.limit, autoAdd: body.autoAdd, resumeLabel: body.resumeLabel },
    { renderPage: renderPageHtml },
  );
  res.status(200).json(result);
}

// Top-level guard so an unexpected error surfaces as a JSON 500 with a
// message (like /api/state) instead of an opaque invocation failure.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    await handlerInner(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
