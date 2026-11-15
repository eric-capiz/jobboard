/* Portal search interaction for the browser render reader.
 *
 * Some employers' careers pages are search portals: they render as an
 * empty shell and show NO jobs until a search is submitted (Walmart,
 * FedEx, CVS, Hilton, Southwest — proven by the render reader's own
 * text samples, 2026-11-11). The render fallback loads the page but
 * never searches, so those companies stay at zero listings.
 *
 * This module is the search step, run inside the same render (same
 * page, same browser session) after the initial load settles:
 *   1. Scan the rendered DOM for a visible job-search box (keyword /
 *      search input) and its submit button — generic, scored by
 *      name / id / placeholder / aria-label, never by site.
 *   2. If the page already shows listings, do nothing — a search would
 *      only risk replacing a working result.
 *   3. Submit an empty search first (all jobs). If the results page
 *      still shows no listings and a resume role term was supplied,
 *      submit again with that term. Submission uses real keystrokes
 *      and Enter (plus a real mouse click on the submit button as a
 *      fallback) — React-controlled portals ignore script-set values
 *      and synthetic .click() calls, so the search must go through
 *      the page's own event flow to register at all.
 *   4. Wait for the results to load (navigation, or a visible-text
 *      change for XHR results, then a short DOM-stable settle),
 *      bounded by the render deadline.
 *   5. The caller returns the final page HTML to the existing
 *      extractors — extraction + scoring are untouched.
 *   6. When no search box is found, the gate resolver drives
 *      through whatever gates the listings (a country picker, a
 *      region/department/language dropdown, a modal, tabs) —
 *      generic heuristics over visible text, roles, and ARIA
 *      labels, never a site-specific label or URL. It opens the
 *      gate, picks the option matching the sweep target (United
 *      States, remote / work-from-home, English, or the resume's
 *      role term for a department filter), waits for the page to
 *      settle, and re-scans. A gate that reveals listings ends
 *      the search at once; one that reveals the box lets the
 *      retry submit it.
 *
 * SOURCE DISCIPLINE: the search happens ONLY on the company's own
 * careers page — the same URL the render already opened. The form's
 * own action is checked before submitting (a board action refuses the
 * submit), and if a submit navigates onto a board domain the render
 * returns null. No board domain or ATS API is ever opened as a source;
 * no out-link is ever followed. `isBoardUrl` is the same guard the
 * render reader already uses.
 *
 * DEFENSIVE: every step is wrapped — no form, a failed submit, a
 * timeout, or an evaluate error returns an outcome, never a throw, so
 * a portal that resists searching costs nothing but its render budget
 * and the chunk moves on.
 *
 * $0: no new dependency — puppeteer-core only (already in the render
 * reader). The in-page functions below run inside the browser via
 * page.evaluate, so they must stay self-contained: no imports, no
 * closures over module state, NO calls to module-level helpers —
 * page.evaluate serializes the function ALONE and any free reference
 * throws ReferenceError in the page (round 13 broke listingsNow
 * exactly this way when countJobListings called hasResultsCountText;
 * the FakePage suite dispatches by function name and CANNOT catch
 * serialization breakage — only the local Chromium driver
 * local-verify/driver.ts proves an in-page function runs in a real
 * browser). The selection logic runs in Node on the serialized
 * descriptors, so the offline test suite can drive it with canned
 * data and a fake page — no real browser needed there.
 */

import { isBoardUrl } from './finder-lib.js';

/** The slice of a Puppeteer page the search step needs. A real
 *  puppeteer Page satisfies this structurally; tests pass a fake. */
export interface SearchablePage {
  url(): string;
  evaluate(fn: (...args: any[]) => any, ...args: any[]): Promise<any>;
  evaluateHandle(fn: (...args: any[]) => any, ...args: any[]): Promise<SearchableHandle>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}

export interface SearchableHandle {
  asElement(): SearchableElement | null;
  dispose(): Promise<void>;
}

export interface SearchableElement {
  click(): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  evaluate(fn: (...args: any[]) => any, ...args: any[]): Promise<any>;
}

/* ------------------------------------------------------------------ */
/* In-page descriptors + functions (run inside the browser)            */
/* ------------------------------------------------------------------ */

export interface SearchInputDescriptor {
  /** Index into document.querySelectorAll('input'). */
  index: number;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  /** ARIA role — some portals label the box by role (combobox), not
   *  by name or placeholder (Alorica's bling-ai portal). */
  role: string;
  /** class attribute — the signal often lives in the class
   *  (job-search-input) when name/placeholder are generic. */
  cls: string;
  /** title attribute. */
  title: string;
  /** Text of associated <label> elements. */
  labelText: string;
  /** Text of aria-describedby targets ("This is a search field with
   *  an auto-suggest feature attached" — Alorica). */
  describedBy: string;
  /** Index into document.querySelectorAll('form'), -1 when the input
   *  is not inside a form (React SPA search). */
  formIndex: number;
  visible: boolean;
  /** Viewport-relative top edge (px) — picks the submit button nearest
   *  the input, since a page can carry two search boxes (header +
   *  hero) with a "Search" button each. */
  top: number;
}

export interface SearchButtonDescriptor {
  /** Index into document.querySelectorAll('button, input[type="submit"], input[type="button"]'). */
  index: number;
  text: string;
  ariaLabel: string;
  /** title attribute — some submit buttons carry only a title. */
  title: string;
  type: string;
  formIndex: number;
  visible: boolean;
  /** Viewport-relative top edge (px) — see SearchInputDescriptor. */
  top: number;
}

export interface SearchFormInfo {
  inputs: SearchInputDescriptor[];
  buttons: SearchButtonDescriptor[];
  forms: { action: string; method: string }[];
}

export interface JobListingCount {
  /** Visible links that look like job postings (non-generic text,
   *  job-ish href). */
  jobLinks: number;
  /** Body text states a results count ("1-25 of 4,659 jobs"). */
  resultsText: boolean;
}

/** Serialize the page's search inputs, buttons, and forms. Runs in the
 *  browser; the selection logic (below) runs in Node on this data, so
 *  a test can drive it with canned descriptors and no browser. */
export function scanSearchForm(): SearchFormInfo {
  const forms = Array.from(document.querySelectorAll('form'));
  const formIndexOf = (el: Element): number => {
    const f = el.closest('form');
    return f ? forms.indexOf(f) : -1;
  };
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      return getComputedStyle(el).visibility !== 'hidden';
    } catch {
      return true;
    }
  };
  const topOf = (el: Element): number => Math.round(el.getBoundingClientRect().top);
  const inputs: SearchInputDescriptor[] = Array.from(document.querySelectorAll('input')).map(
    (el, index) => ({
      index,
      type: (el.getAttribute('type') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      cls: el.getAttribute('class') || '',
      title: el.getAttribute('title') || '',
      labelText: (() => {
        try {
          const labels = (el as HTMLInputElement).labels;
          return labels ? Array.from(labels).map((l) => l.innerText || '').join(' ') : '';
        } catch {
          return '';
        }
      })(),
      describedBy: (() => {
        try {
          const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
          return ids.map((id) => document.getElementById(id)?.innerText || '').join(' ');
        } catch {
          return '';
        }
      })(),
      formIndex: formIndexOf(el),
      visible: isVisible(el),
      top: topOf(el),
    }),
  );
  const buttons: SearchButtonDescriptor[] = Array.from(
    document.querySelectorAll('button, input[type="submit"], input[type="button"]'),
  ).map((el, index) => ({
    index,
    text: ((el as HTMLElement).innerText || el.getAttribute('value') || '').trim(),
    ariaLabel: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
    type: (el.getAttribute('type') || '').toLowerCase(),
    formIndex: formIndexOf(el),
    visible: isVisible(el),
    top: topOf(el),
  }));
  return {
    inputs,
    buttons,
    forms: forms.map((f) => ({
      action: f.getAttribute('action') || '',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
    })),
  };
}

/** Whether the page's body text states a POSITIVE results count —
 *  the "listings present" half of hasVisibleListings. Pure (takes
 *  the text), so the offline suite can drive it directly. KEEP IN
 *  SYNC with countJobListings: the in-page function cannot call
 *  this helper (page.evaluate serializes the function alone — a
 *  call to it throws ReferenceError in the page), so the patterns
 *  are duplicated there. The local Chromium driver
 *  (local-verify/driver.ts, fixture A) is the guard that the two
 *  agree in a real browser. Three shapes, all requiring the count
 *  to be above zero (portals show "Search results (0 jobs
 *  available)" on the empty shell, and that line plus a nav link
 *  would otherwise read as "listings present" and skip the search
 *  entirely — proven on Concentrix 2026-11-11):
 *  "1-25 of 4,659 jobs" (adjacent count word), "Results 1 – 10 of
 *  34" (Phenom's range format — no count word adjacent to any
 *  number, so the adjacent-count pattern misses it entirely, and
 *  the search step then submits on a results page and destroys the
 *  country context the gate pick just established: Foundever round-12
 *  canary, US + Work-from-Home picked, then an empty submit landed
 *  on the global /search/ page and returned Budapest roles), and
 *  "1 – 10 of 34 jobs" (range + count word). The range formats take
 *  the TRAILING total (34), not the page size (10). */
export function hasResultsCountText(bodyText: string): boolean {
  for (const m of bodyText.matchAll(/([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi)) {
    if (parseInt(m[1].replace(/,/g, ''), 10) > 0) return true;
  }
  for (const m of bodyText.matchAll(/results?\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)/gi)) {
    if (parseInt(m[1].replace(/,/g, ''), 10) > 0) return true;
  }
  for (const m of bodyText.matchAll(
    /[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi,
  )) {
    if (parseInt(m[1].replace(/,/g, ''), 10) > 0) return true;
  }
  return false;
}

/** Cheap listing heuristic for the rendered page: visible job-looking
 *  links, plus a "N jobs" results count in the body text. */
export function countJobListings(): JobListingCount {
  const GENERIC =
    /^(home|about|about us|careers|jobs|job|contact|contact us|login|sign in|join our team|work with us|open positions|current openings|open roles|all roles|see all jobs|view all jobs|view jobs|see jobs|browse jobs|search jobs|browse all jobs|view openings|see openings|view open positions|all jobs|all positions|explore careers|explore jobs|learn more|apply now|view details|view job|see details)$/i;
  let jobLinks = 0;
  for (const a of Array.from(document.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || '';
    const text = (a.innerText || '').trim();
    if (text.length < 3 || GENERIC.test(text)) continue;
    if (!/job|career|position|opening|apply/i.test(href)) continue;
    const r = a.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    jobLinks += 1;
  }
  const bodyText = document.body?.innerText || '';
  // A results count only counts when it is ABOVE ZERO: portals show
  // "Search results (0 jobs available)" on the empty shell, and that
  // line plus a nav link ("Search & Apply" -> /job-search/) would
  // otherwise read as "listings present" and skip the search entirely
  // — proven on Concentrix 2026-11-11, where the portal-direct render
  // returned the shell untouched because of exactly this. "1-25 of
  // 4,659 jobs" still counts (4,659 > 0); "0 jobs" never does.
  // "roles" joins the count words: Rippling boards count their list
  // as "9 roles across all departments" (Liveops, 2026-11-12), and
  // without it the search step hides a visible list behind a term
  // search that returns nothing.
  // The patterns below are INLINED here on purpose — they duplicate
  // hasResultsCountText, because this function runs inside the
  // browser via page.evaluate, which serializes the function ALONE:
  // any call to a module-level helper throws ReferenceError in the
  // page, listingsNow reads false, and the search step submits over
  // a results page it should have harvested (caught by the local
  // Chromium reproduction 2026-11-12: both fixtures harvested their
  // leads via the HTML path while listingsNow stayed false). KEEP
  // THE TWO IN SYNC — the offline suite tests hasResultsCountText,
  // the local Chromium driver tests this function in a real browser.
  let resultsText = false;
  for (const m of bodyText.matchAll(/([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi)) {
    if (parseInt(m[1].replace(/,/g, ''), 10) > 0) {
      resultsText = true;
      break;
    }
  }
  if (!resultsText) {
    // Phenom's range format, "Results 1 – 10 of 34": no number sits
    // adjacent to a count word, so the pattern above misses it — and
    // the search then submits on a results page and destroys the
    // country context the gate pick just established (Foundever
    // round-12 canary). The trailing total (34) is the count.
    for (const m of bodyText.matchAll(/results?\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)/gi)) {
      if (parseInt(m[1].replace(/,/g, ''), 10) > 0) {
        resultsText = true;
        break;
      }
    }
  }
  if (!resultsText) {
    for (const m of bodyText.matchAll(
      /[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+([\d,]+)\s+(jobs?|results?|openings?|positions?|roles?)\b/gi,
    )) {
      if (parseInt(m[1].replace(/,/g, ''), 10) > 0) {
        resultsText = true;
        break;
      }
    }
  }
  return { jobLinks, resultsText };
}

/* ------------------------------------------------------------------ */
/* Selection (pure — runs in Node on the scan data)                    */
/* ------------------------------------------------------------------ */

/** Score a visible text input as the portal's keyword box. Location
 *  boxes score negative (they also say "search"); a bare input with no
 *  job-search signal scores too low to trust. The signal spans every
 *  way a portal can label its box — name / id / placeholder /
 *  aria-label (before), plus role, class, title, <label> text, and
 *  aria-describedby text (2026-11-11: Alorica's box is described, not
 *  named, and its render text proves a search field the old signal
 *  could not see). */
function scoreSearchInput(d: SearchInputDescriptor): number {
  if (
    ['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset'].includes(
      d.type,
    )
  ) {
    return -100;
  }
  const signal = `${d.name} ${d.id} ${d.placeholder} ${d.ariaLabel} ${d.role || ''} ${d.cls || ''} ${d.title || ''} ${d.labelText || ''} ${d.describedBy || ''}`.toLowerCase();
  let score = 0;
  if (/location|zip|city|state|postal|radius|distance/.test(signal)) score -= 3;
  if (/keyword/.test(signal)) score += 4;
  if (/\bsearch\b/.test(signal)) score += 2;
  if (/job|title|\bwhat\b|role|position/.test(signal)) score += 2;
  // "This is a search field" states outright that the input IS the
  // search box — worth as much as the word 'search' itself.
  if (/search (field|box|input)|find (jobs|a job)/.test(signal)) score += 2;
  if (d.name === 'q' || d.id === 'q') score += 2;
  if (d.type === 'search') score += 2;
  if (/combobox|searchbox/.test((d.role || '').toLowerCase())) score += 2;
  if (d.formIndex >= 0) score += 1;
  return score;
}

/** Button label for matching: visible text + aria-label + title. */
function buttonLabel(b: SearchButtonDescriptor): string {
  return `${b.text} ${b.ariaLabel} ${b.title || ''}`;
}

export interface SearchSelection {
  input: SearchInputDescriptor;
  button: SearchButtonDescriptor | null;
  /** The chosen input's form action ('' when no form / no action —
   *  a same-page JS submit). */
  formAction: string;
}

/** Pick the portal's keyword box + submit button from a scan. Null
 *  when no input qualifies (no search box on this page). */
export function selectSearchInput(info: SearchFormInfo): SearchSelection | null {
  let best: SearchInputDescriptor | null = null;
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
  const sameForm =
    best.formIndex >= 0
      ? info.buttons.filter((b) => b.visible && b.formIndex === best!.formIndex)
      : [];
  // A page can carry two search boxes (header + hero) with a "Search"
  // button each — take the candidate nearest the chosen input, not the
  // first in the DOM, so the click submits THIS box.
  const nearest = (
    list: SearchButtonDescriptor[],
  ): SearchButtonDescriptor | undefined => {
    let pick: SearchButtonDescriptor | undefined;
    let pickDist = Number.POSITIVE_INFINITY;
    for (const b of list) {
      const d = Math.abs(b.top - best!.top);
      if (d < pickDist) {
        pick = b;
        pickDist = d;
      }
    }
    return pick;
  };
  const byText = (list: SearchButtonDescriptor[]): SearchButtonDescriptor | undefined =>
    nearest(list.filter((b) => /search|find/i.test(buttonLabel(b))));
  const button =
    byText(sameForm) ??
    nearest(sameForm.filter((b) => b.type === 'submit')) ??
    nearest(
      info.buttons.filter(
        (b) => b.visible && /search jobs|find jobs/i.test(buttonLabel(b)),
      ),
    ) ??
    // A bare "Search" button (Walmart, Phenom): the portal's own
    // submit, labelled with nothing more specific.
    nearest(
      info.buttons.filter((b) => b.visible && /\bsearch\b/i.test(buttonLabel(b))),
    ) ??
    null;
  const formAction = best.formIndex >= 0 ? info.forms[best.formIndex]?.action ?? '' : '';
  return { input: best, button, formAction };
}

/** Pick the portal's separate location box from a scan, if one
 *  exists: an input whose name/id/placeholder/label signals a
 *  place (location, city, state, zip, where). scoreSearchInput
 *  already penalises location inputs (-3) so they are never picked
 *  as the keyword box — this is the complement: the box to fill
 *  with "Remote" before re-submitting. Null when no visible input
 *  matches. Depth fix (2026-11-14). */
export function selectLocationInput(info: SearchFormInfo): SearchInputDescriptor | null {
  let best: SearchInputDescriptor | null = null;
  let bestScore = 0;
  for (const d of info.inputs) {
    if (!d.visible) continue;
    if (
      ['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset'].includes(
        d.type,
      )
    ) {
      continue;
    }
    const signal = `${d.name} ${d.id} ${d.placeholder} ${d.ariaLabel} ${d.cls || ''} ${d.title || ''} ${d.labelText || ''}`.toLowerCase();
    if (!/location|city|state|zip|postal|where/.test(signal)) continue;
    const score = /location/.test(signal) ? 2 : 1;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** The page already displays a results list: a results-count line
 *  ("Showing 1-25 of 4,659 jobs") backed by at least one job link.
 *  Bare job links alone are NOT listings — a homepage's trending-role
 *  cards and career-area links (Walmart: 25 of them) look like jobs
 *  to a link counter, but the extractor finds nothing on them, so
 *  skipping the search on their say-so strands the company at zero.
 *  The extractor is the authority on whether listings were found; a
 *  redundant search on a page that already lists jobs costs only
 *  seconds, while a skipped search costs the whole company. */
export function hasVisibleListings(count: JobListingCount): boolean {
  return count.resultsText && count.jobLinks >= 1;
}

/** A form action is safe to submit when it stays on a non-board URL:
 *  an empty action submits to the same page; a board action refuses
 *  the submit outright. */
export function isSearchActionAllowed(action: string, pageUrl: string): boolean {
  if (!action) return true;
  try {
    return !isBoardUrl(new URL(action, pageUrl).href);
  } catch {
    return false;
  }
}

/** A form action that submits to a bare site search, not a jobs
 *  portal: the action names a different page whose path has no
 *  job/career/search word (WordPress ?s= site search submits to the
 *  homepage '/'). The box that qualified is the site's header search,
 *  not the portal's job search — submitting it wastes the render on a
 *  site search (Omni: ?s=service+customer, no-results) and strands
 *  the real portal unrendered. An empty action (same-page JS submit)
 *  is NOT site search — most real portals submit in place. */
export function isSiteSearchAction(action: string, pageUrl: string): boolean {
  if (!action) return false;
  try {
    const target = new URL(action, pageUrl);
    if (target.href === new URL(pageUrl).href) return false;
    return !/job|career|search|opening|position|role|result|listing/i.test(target.pathname + target.search);
  } catch {
    return false;
  }
}

/** Diagnostics for a no-form render: how many inputs the scan saw,
 *  how many were visible, and the best input score — so a live
 *  no-form can be told apart: "no inputs at all" (empty shell) vs
 *  "inputs exist but none qualifies" (collapsed panel, unlabeled
 *  combobox) vs "a box qualified but its action is a board". */
export type SearchScanSummary = {
  inputs: number;
  visibleInputs: number;
  bestScore: number;
  buttons: number;
};

export function summarizeScan(info: SearchFormInfo): SearchScanSummary {
  let best: number | null = null;
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
    buttons: info.buttons.filter((b) => b.visible).length,
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration (runs in Node against the live page)                  */
/* ------------------------------------------------------------------ */

export type PortalSearchOutcome =
  | 'has-listings' // the rendered page already shows jobs — no search needed
  | 'searched' // a submit ran and the page now shows listings
  | 'no-form' // no qualifying search box (or its action is a board URL)
  | 'submit-failed' // the submit itself could not be performed
  | 'no-results' // submits ran but the page still shows no listings
  | 'board-redirect' // a submit navigated onto a board domain
  | 'skipped-time'; // not enough render budget left to attempt a search

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function textLength(page: SearchablePage): Promise<number> {
  try {
    const len = await page.evaluate(() => document.body?.innerText?.length ?? 0);
    return typeof len === 'number' ? len : -1;
  } catch {
    return -1;
  }
}

/** Poll the page's visible text until it stops changing for two polls
 *  (the same signal as the render reader's settle), bounded by the
 *  remaining render budget. Never throws. */
export async function waitForDomStable(
  page: SearchablePage,
  remainMs: () => number,
  capMs: number,
  intervalMs: number,
): Promise<void> {
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

async function listingsNow(page: SearchablePage): Promise<boolean> {
  try {
    return hasVisibleListings((await page.evaluate(countJobListings)) as JobListingCount);
  } catch {
    return false;
  }
}

/** Wait up to capMs for the page to change after a submit: a
 *  navigation, or a visible-text change (XHR results). Returns whether
 *  anything changed. Bounded by the remaining render budget. */
async function waitForChange(
  page: SearchablePage,
  remainMs: () => number,
  startUrl: string,
  startLen: number,
  capMs: number,
): Promise<boolean> {
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

/** Submit by typing into the box and pressing Enter — the way a person
 *  searches, and the only way React-controlled portals register the
 *  term. Setting the input's value from script and calling .click()
 *  on the button does NOT work there (proven on Walmart: both submits
 *  silently did nothing, while real keystrokes + Enter navigated to
 *  the results page). Real keystrokes go through the portal's own
 *  event flow, so its state actually updates. Never throws — false
 *  when the submit could not even be attempted. */
async function submitViaEnter(
  page: SearchablePage,
  sel: SearchSelection,
  term: string,
): Promise<boolean> {
  let handle: SearchableHandle | null = null;
  try {
    handle = await page.evaluateHandle(
      (idx: number) => document.querySelectorAll('input')[idx],
      sel.input.index,
    );
  } catch {
    handle = null;
  }
  const el = handle?.asElement() ?? null;
  if (el) {
    try {
      // A real mouse click focuses the input (and opens any search
      // overlay the box lives behind). A failed click falls through
      // to the focus below — typing may still work.
      await el.click();
    } catch {
      try {
        await el.evaluate((node) => (node as HTMLInputElement).focus());
      } catch {
        // Focus failure still leaves the Enter press a chance.
      }
    }
    if (term) {
      try {
        // Clear any residue through the keyboard, not the DOM value —
        // a script-set value leaves React state stale, and the next
        // keystroke would then fight it. Best-effort: the typed term
        // still appends when the clear itself fails.
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      } catch {
        // Clearing is best-effort; the typed term still appends.
      }
      try {
        await el.type(term, { delay: 20 });
      } catch {
        return false;
      }
    }
  } else {
    try {
      await page.evaluate((idx: number) => {
        const input = document.querySelectorAll('input')[idx] as
          | HTMLInputElement
          | undefined;
        input?.focus();
      }, sel.input.index);
    } catch {
      // Focus failure still leaves the Enter press a chance.
    }
  }
  try {
    await page.keyboard.press('Enter');
    return true;
  } catch {
    return false;
  } finally {
    try {
      await handle?.dispose();
    } catch {
      // Disposal is housekeeping, never load-bearing.
    }
  }
}

/** Click a submit button through a real mouse click (trusted event),
 *  not .click() — React portals ignore synthetic clicks the same way
 *  they ignore script-set values. */
async function clickButton(page: SearchablePage, buttonIndex: number): Promise<boolean> {
  let handle: SearchableHandle | null = null;
  try {
    handle = await page.evaluateHandle(
      (idx: number) =>
        document.querySelectorAll('button, input[type="submit"], input[type="button"]')[idx],
      buttonIndex,
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
      // Disposal is housekeeping, never load-bearing.
    }
  }
}

type AttemptResult = 'no-form' | 'failed' | 'settled' | 'board';

/** Fill the location box with "Remote" through real keystrokes —
 *  React-controlled portals ignore script-set values, same as the
 *  keyword box. Clears residue first via keyboard, like
 *  submitViaEnter. Returns false when the fill could not be
 *  attempted. Depth fix (2026-11-14). */
async function fillLocationInput(page: SearchablePage, inputIndex: number): Promise<boolean> {
  let handle: SearchableHandle | null = null;
  try {
    handle = await page.evaluateHandle(
      (idx: number) => document.querySelectorAll('input')[idx],
      inputIndex,
    );
  } catch {
    return false;
  }
  const el = handle?.asElement() ?? null;
  try {
    if (!el) return false;
    try {
      await el.click();
    } catch {
      try {
        await el.evaluate((node) => (node as HTMLInputElement).focus());
      } catch {
        // Focus failure still leaves typing a chance.
      }
    }
    try {
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    } catch {
      // Clearing is best-effort.
    }
    try {
      await el.type('Remote', { delay: 20 });
    } catch {
      return false;
    }
    return true;
  } finally {
    try {
      await handle?.dispose();
    } catch {
      // Disposal is housekeeping, never load-bearing.
    }
  }
}

/** The no-form rescue: a portal whose search lives behind a "Search
 *  jobs / Find jobs" toggle button — a collapsed panel, or a header
 *  button that opens the search overlay — shows NO qualifying input
 *  to the scan, because the box does not exist until the toggle is
 *  clicked. One click, then the caller re-scans. A button whose form
 *  submits to a board URL is never the toggle (the board-action
 *  refusal stands). Bounded by the same budget as a search attempt. */
async function clickSearchToggle(
  page: SearchablePage,
  remainMs: () => number,
  onToggle?: (label: string) => void,
): Promise<'toggled' | 'board' | null> {
  // A toggle click is one click plus a short change wait (~3s),
  // not the 6s a full search attempt needs. The old 6000ms gate
  // starved the toggle itself on a late-starting search step
  // (round-11 canary, Foundever attempt 1: toggle never fired).
  // Every wait below is bounded by remainMs(), so a short budget
  // degrades gracefully instead of overrunning the render.
  if (remainMs() < 3000) return null;
  let info: SearchFormInfo;
  try {
    info = (await page.evaluate(scanSearchForm)) as SearchFormInfo;
  } catch {
    return null;
  }
  const allowed = (b: SearchButtonDescriptor): boolean => {
    if (b.formIndex < 0) return true;
    const action = info.forms[b.formIndex]?.action ?? '';
    return isSearchActionAllowed(action, page.url()) && !isSiteSearchAction(action, page.url());
  };
  const label = (b: SearchButtonDescriptor): string => buttonLabel(b).trim();
  // The entry button is not always labelled "Search": Foundever's
  // portal gates its search behind "Find a job in your country"
  // (a country picker — the search form is display:none until a
  // country is picked, 15 inputs, 0 visible, 2026-11-12 canary).
  // "Find a job" (singular) is the entry; the bare /\bsearch\b/
  // fallback would also catch a site-search toggle, so the
  // entry-phrase tier runs first.
  const pick =
    info.buttons.find((b) => b.visible && allowed(b) && /search jobs|find jobs|find a job/i.test(label(b))) ??
    info.buttons.find((b) => b.visible && allowed(b) && /\bsearch\b/i.test(label(b))) ??
    null;
  if (!pick) return null;
  const startUrl = page.url();
  const startLen = await textLength(page);
  if (!(await clickButton(page, pick.index))) return null;
  // Report the click BEFORE waiting: the caller needs to know the
  // toggle fired even if the page it reveals has no form (Sitel:
  // the toggle may reveal a country picker, not a search box).
  onToggle?.(label(pick));
  await waitForChange(page, remainMs, startUrl, startLen, 4000);
  if (isBoardUrl(page.url())) return 'board';
  return 'toggled';
}

/* ------------------------------------------------------------------ */
/* Gate resolver — generic, no site-specific labels                    */
/* ------------------------------------------------------------------ */

/** Some portals gate their listings behind a control that must be
 *  driven through before any job appears: a country picker modal
 *  ("Find a job in your country" -> "United States (USA)" ->
 *  /go/Search-Jobs-US/ — Foundever, proven by hand 2026-11-12, 34
 *  US jobs behind the picker while the app saw an empty homepage),
 *  a native <select> for region/department/language, a listbox, a
 *  tab set, a modal. The old country-only rescue failed this exact
 *  page twice over: its finder required the label to be EXACTLY
 *  "United States" (the real option reads "United States (USA)"),
 *  and its 6000ms budget gate refused the pick because the search
 *  step starts late in the render (load + cookie passes + settles
 *  burn most of the 20s), so the toggle fired and the pick never
 *  did (round-11 canary: searchToggleClicked set, searchCountryClicked
 *  null, both attempts).
 *
 *  The resolver is generic: it scans every visible button, link,
 *  tab, menu item, and native select, and matches by heuristics
 *  over visible text, roles, and ARIA labels — never a site's
 *  labels, URLs, or selectors. One action per call (a pick, or an
 *  opener click that reveals the options), so the caller re-scans
 *  after each step and the loop below can stack gates (country,
 *  then department). Targets, in priority order: United States
 *  (locale gates block everything), English (language gates block
 *  reading), remote / work-from-home (the sweep's remote-only
 *  lane), and the resume's role term (a department filter).
 *
 *  Safety: an option is only clickable when it sits in a picker
 *  container (listbox/menu/dialog/tablist, or a picker/modal/
 *  dropdown class on an ancestor) or a gate was already opened in
 *  this search step — a bare page link is pickable only on an
 *  exact target match AND a same-host href, so a board link is
 *  never followed. A job title that happens to contain the role
 *  words ("Remote Customer Service Representative 1") is never a
 *  department option: it carries a digit or a role noun. A gate
 *  action is one click plus a short change wait (~2.5s), not the
 *  6s a full search attempt needs, so a late-starting search step
 *  can still drive through a gate. Every action is verified after:
 *  the caller re-scans for listings or a search box, and a wrong
 *  pick costs one loop iteration, not the company. */

export interface GateOptionDescriptor {
  /** Index into the select's options. */
  index: number;
  text: string;
  value: string;
  selected: boolean;
}

export interface GateControlDescriptor {
  /** 'button' addresses document.querySelectorAll('button, a,
   *  [role="tab"], [role="option"], [role="menuitem"], [role="button"]');
   *  'select' addresses document.querySelectorAll('select'). */
  kind: 'button' | 'select';
  index: number;
  /** Visible text (buttons) or label (selects: <label> /
   *  aria-label / name / id / title). */
  label: string;
  ariaLabel: string;
  /** href for links ('' for buttons and selects). */
  href: string;
  /** Nearest ancestor role among listbox/menu/dialog/tablist/
   *  combobox, or ''. */
  containerRole: string;
  /** True when an ancestor carries a picker/modal/menu/dropdown
   *  class or id — a picker container without an ARIA role. */
  containerClass: boolean;
  /** ARIA role of the element itself (tag name when none). */
  role: string;
  visible: boolean;
  /** Options of a select (empty for buttons). */
  options: GateOptionDescriptor[];
}

export interface GateScanResult {
  controls: GateControlDescriptor[];
}

/** Serialize the page's gate controls. Runs in the browser; the
 *  selection logic (below) runs in Node on this data, so a test can
 *  drive it with canned descriptors and no browser. */
export function scanGateControls(): GateScanResult {
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      return getComputedStyle(el).visibility !== 'hidden';
    } catch {
      return true;
    }
  };
  const containerOf = (el: Element): { role: string; cls: boolean } => {
    let role = '';
    let cls = false;
    let node: Element | null = el.parentElement;
    while (node) {
      if (!role) {
        const r = (node.getAttribute?.('role') || '').toLowerCase();
        if (['listbox', 'menu', 'dialog', 'tablist', 'combobox'].includes(r)) role = r;
      }
      if (!cls) {
        const c = `${node.getAttribute?.('class') || ''} ${node.getAttribute?.('id') || ''}`;
        if (/picker|modal|menu|dropdown|listbox|dialog|popover|popup|drawer|overlay/i.test(c)) cls = true;
      }
      if (role && cls) break;
      node = node.parentElement;
    }
    return { role, cls };
  };
  const selectLabel = (el: HTMLSelectElement): string => {
    try {
      const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
      if (labels && labels.length) {
        return Array.from(labels)
          .map((l) => l.innerText || '')
          .join(' ');
      }
    } catch {
      // No labels — fall through to the attributes.
    }
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.getAttribute('id') ||
      el.getAttribute('title') ||
      ''
    );
  };
  const controls: GateControlDescriptor[] = [];
  const btns = Array.from(
    document.querySelectorAll('button, a, [role="tab"], [role="option"], [role="menuitem"], [role="button"]'),
  ) as HTMLElement[];
  btns.forEach((el, index) => {
    const cont = containerOf(el);
    controls.push({
      kind: 'button',
      index,
      label: (el.innerText || '').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      href: el.getAttribute('href') || '',
      containerRole: cont.role,
      containerClass: cont.cls,
      role: (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase(),
      visible: isVisible(el),
      options: [],
    });
  });
  const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
  selects.forEach((el, index) => {
    const cont = containerOf(el);
    controls.push({
      kind: 'select',
      index,
      label: selectLabel(el),
      ariaLabel: el.getAttribute('aria-label') || '',
      href: '',
      containerRole: cont.role,
      containerClass: cont.cls,
      role: 'select',
      visible: isVisible(el),
      options: Array.from(el.options).map((o, oi) => ({
        index: oi,
        text: (o.text || '').trim(),
        value: o.value || '',
        selected: o.selected,
      })),
    });
  });
  return { controls };
}

/** In-page handle getter for a gate button/link (named so the
 *  offline test can tell its clicks apart from toggle clicks). */
function gateButtonElement(idx: number): Element | null {
  return (
    document.querySelectorAll('button, a, [role="tab"], [role="option"], [role="menuitem"], [role="button"]')[idx] ??
    null
  );
}

/** In-page pick for a native <select> option (named so the offline
 *  test can drive it with canned data). A native dropdown's options
 *  are not real-clickable the way a button is, so the value is set
 *  through the native setter and input/change events are dispatched
 *  — the same mechanism puppeteer's page.select uses, so a
 *  React-controlled select registers the change. Self-contained: no
 *  imports, no closures over module state. */
export function pickSelectOption(selectIndex: number, optionIndex: number): boolean {
  const sel = document.querySelectorAll('select')[selectIndex] as HTMLSelectElement | undefined;
  const opt = sel?.options[optionIndex];
  if (!sel || !opt) return false;
  try {
    const setter = Object.getOwnPropertyDescriptor(
      (window as unknown as { HTMLSelectElement: typeof HTMLSelectElement }).HTMLSelectElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(sel, opt.value);
    else sel.value = opt.value;
  } catch {
    sel.value = opt.value;
  }
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value === opt.value;
}

/** Normalize a gate label for matching: collapse whitespace, drop
 *  a trailing parenthetical ("United States (USA)" -> "United
 *  States"), and drop any trailing " - ..." / ", ..." suffix
 *  ("United States - English", "Remote, USA"). The round-11 miss
 *  was an exact match against the raw label; the option's real
 *  text carries exactly these suffixes. */
export function normalizeGateLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/\s*[-–—|,].*$/, '')
    .trim();
}

export type GateTarget = 'us' | 'remote' | 'english' | 'role';

export interface GateAction {
  kind: 'button' | 'select';
  index: number;
  /** For a select pick: the option's index. */
  optionIndex?: number;
  /** Raw label of what was picked / opened (reported, not matched). */
  label: string;
  target: GateTarget | 'open';
}

/** Role nouns a department name never carries — a job title that
 *  happens to contain the resume's role words ("Remote Customer
 *  Service Representative 1") is not a department option. */
const ROLE_NOUNS = /representative|manager|associate|specialist|agent|engineer|analyst|coordinator|lead|director|supervisor|technician|consultant|officer/i;

/** Match a normalized label against the sweep targets. The role
 *  target is a phrase match on the search term's words in any
 *  order — the live term is the resume's two most frequent words
 *  (e.g. 'service customer'), while the option reads 'Customer
 *  Service'. Short labels only, no digits, no role noun: a job
 *  title is never a department option. */
function gateTargetOf(normalized: string, searchTerm: string): GateTarget | null {
  if (/^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i.test(normalized)) return 'us';
  if (/^english$/i.test(normalized)) return 'english';
  if (/^(remote|work[- ]from[- ]home|wfh)$/i.test(normalized)) return 'remote';
  if (searchTerm) {
    const words = searchTerm
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (words.length > 0 && wordCount <= 4 && !/\d/.test(normalized) && !ROLE_NOUNS.test(normalized)) {
      const lower = normalized.toLowerCase();
      const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (words.every((w) => new RegExp(`\\b${esc(w)}\\b`).test(lower))) return 'role';
    }
  }
  return null;
}

const GATE_TARGET_PRIORITY: Record<GateTarget, number> = { us: 0, english: 1, remote: 2, role: 3 };

/** Pick the one gate action to take from a scan, or null. Picks
 *  beat openers, and the target priority is US, then English, then
 *  remote, then the role term. `gateOpened` is true once a toggle
 *  or a gate opener has fired in this search step: a bare page
 *  link is only pickable in that context (the picker it opened is
 *  what the option belongs to), and only on an exact target match
 *  with a same-host href. A role-term pick needs a picker
 *  container even then — a bare link matching the role words is a
 *  job, not a department. Pure — runs in Node on the scan data. */
export function selectGateAction(
  scan: GateScanResult,
  searchTerm: string,
  gateOpened: boolean,
  pageUrl: string,
  // Labels already driven on this page (a non-navigating pick that
  // revealed no listings): re-picking one accomplishes nothing, and
  // the resolver must move on to the next gate instead of clicking
  // the same button again.
  excludeLabels: string[] = [],
  // Gate targets already satisfied on this page: a language pick
  // after a country pick is never a job filter — it switches the
  // UI language — and the loop would otherwise click 'English',
  // then 'French', then 'Spanish', burning the re-submit budget
  // (Alorica's bling-ai portal, 2026-11-12 local round). A language
  // pick is still valid BEFORE any country pick (a Language opener
  // whose English option routes to the US portal).
  excludeTargets: GateTarget[] = [],
): GateAction | null {
  const excluded = (rawLabel: string): boolean =>
    excludeLabels.some((x) => normalizeGateLabel(x) === normalizeGateLabel(rawLabel));
  let bestPick: GateAction | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  const consider = (action: GateAction): void => {
    const p = GATE_TARGET_PRIORITY[action.target as GateTarget];
    if (p < bestPriority) {
      bestPick = action;
      bestPriority = p;
    }
  };
  for (const c of scan.controls) {
    if (!c.visible) continue;
    if (c.kind === 'select') {
      if (c.options.length < 2) continue;
      for (const opt of c.options) {
        if (opt.selected || !opt.text.trim()) continue;
        const target = gateTargetOf(normalizeGateLabel(opt.text), searchTerm);
        if (target) {
          consider({ kind: 'select', index: c.index, optionIndex: opt.index, label: opt.text.trim(), target });
        }
      }
      continue;
    }
    const raw = (c.label || c.ariaLabel || '').trim();
    if (!raw) continue;
    const normalized = normalizeGateLabel(raw);
    if (!normalized) continue;
    if (excluded(raw)) continue;
    const inPicker =
      c.containerRole !== '' || c.containerClass || c.role === 'tab' || c.role === 'option' || c.role === 'menuitem';
    const target = gateTargetOf(normalized, searchTerm);
    if (!target) continue;
    if (excludeTargets.includes(target)) continue;
    if (target === 'role' && !inPicker) continue;
    // A bare locale link ("United States", "English") is pickable
    // without a gate having opened: the label is an exact locale
    // match — a job title is never exactly "United States" — and the
    // same-host + not-a-board checks below still apply. Omni's
    // country list is bare footer links, no dropdown container, and
    // the old rule left them unpickable forever (2026-11-12 local
    // round). 'remote' stays gated — a bare "Remote" link is as
    // likely a job card or a location chip as a filter — and 'role'
    // already requires a picker.
    const bareLocale = !inPicker && (target === 'us' || target === 'english');
    if (!inPicker && !gateOpened && !bareLocale) continue;
    if (!inPicker && c.href) {
      // A bare link: only when it stays on the portal's own host —
      // a footer locale link is the portal's country flow, a board
      // link is not. Buttons (href '') carry no such risk.
      try {
        const abs = new URL(c.href, pageUrl);
        if (abs.hostname !== new URL(pageUrl).hostname) continue;
        if (isBoardUrl(abs.href)) continue;
      } catch {
        continue;
      }
    }
    consider({ kind: 'button', index: c.index, label: raw, target });
  }
  if (bestPick) return bestPick;
  // No pickable option — look for a gate opener: a control whose
  // label names the gate itself ("Choose your country", "Language",
  // "Department"). The search toggle's own phrasing is excluded
  // once it has fired (re-clicking it would close the picker it
  // opened); before it has fired it is a legitimate opener for a
  // search step that starved before the toggle.
  // An opener never starts with a nav verb. "Meet Our Leadership
  // Team" is a nav link, not a gate: the old word list matched
  // 'team' in it, the click navigated to the leadership page, and
  // that page's single careers link then read as listings (Omni,
  // 2026-11-12 canary). 'category'/'area'/'division' are gone from
  // the word list for the same reason: a blog's "Category" filter
  // is not a jobs gate (Working Solutions' blog page, same canary),
  // and a bare "Area"/"Division" label is as likely a nav item as
  // a filter. The choose/select/pick phrasing still covers a gate
  // opener that names its field ("Choose your division").
  // An opener is a SHORT imperative/label, never a headline or a
  // question: a 9-word blog title ("What Does 'Choose Your
  // Schedule' Mean at Omni?") and a 15-word FAQ question ("CAN I
  // APPLY IF I LIVE IN A COUNTRY OTHER THAN THE UNITED STATES OR
  // CANADA?") both matched the gate words and navigated the render
  // onto an article/FAQ page (Omni + Working Solutions, 2026-11-12
  // canary). A real opener is at most 6 words ("Find a job in your
  // country" is exactly 6) and never starts with a question word.
  // The word count runs on the label itself (label, else aria-label)
  // — the concatenated text would double-count a control that
  // carries both and block a legitimate 6-word opener.
  for (const c of scan.controls) {
    if (c.kind !== 'button' || !c.visible) continue;
    const text = `${c.label} ${c.ariaLabel}`.trim();
    if (!text) continue;
    if (excluded(text)) continue;
    if (/search jobs|find jobs|find a job/i.test(text) && gateOpened) continue;
    if (/^(meet|our|about|learn|view|explore|read|see|discover|join|contact|get)\b/i.test(text)) continue;
    const openerLabel = normalizeGateLabel(c.label || c.ariaLabel);
    const openerWords = openerLabel.split(/\s+/).filter(Boolean);
    if (openerWords.length > 6) continue;
    if (/^(what|how|why|when|where|which|who|whom|whose|can|could|should|would|will|do|does|did|is|are|was|were|may|might)\b/i.test(openerLabel)) continue;
    if (
      /\b(country|region|location|language|department|choose your|select your|pick your)\b/i.test(
        text,
      )
    ) {
      return { kind: 'button', index: c.index, label: (c.label || c.ariaLabel).trim(), target: 'open' };
    }
  }
  return null;
}

type GateResult = 'picked' | 'navigated' | 'opened' | 'board' | null;

/** Whether the rendered page already shows job cards (links),
 *  regardless of whether a results-count line was recognized. The
 *  count text can sit in a format the detector does not know, or
 *  lag behind the cards — the links themselves are the signal. Used
 *  only after a gate action: at the search step's entry a bare job
 *  link is a teaser, not the list, and must not short-circuit the
 *  search. Two links, not one: a single job-looking link is a nav
 *  item, not a list — a leadership page's "See open roles" link
 *  read as listings and ended the search on the wrong page (Omni,
 *  2026-11-12 canary). A real results page carries many. */
async function jobLinksNow(page: SearchablePage): Promise<boolean> {
  try {
    return ((await page.evaluate(countJobListings)) as JobListingCount).jobLinks >= 2;
  } catch {
    return false;
  }
}

/** Drive through ONE gate: scan, pick the action, perform it, wait
 *  for the page to change and settle. Returns what happened so the
 *  caller can re-scan (a pick may have revealed listings or the
 *  search box; an opener may have revealed the options). 'navigated'
 *  is a pick that changed the page URL — the pick chose its
 *  destination page, and the caller must not submit a search there
 *  (an empty submit resets the context the pick just established).
 *  Null when there is no gate to drive or no budget left. Never throws. */
async function resolveGateOnce(
  page: SearchablePage,
  remainMs: () => number,
  searchTerm: string,
  gateOpened: boolean,
  onCountry?: (label: string) => void,
  onGate?: (label: string) => void,
  excludeLabels: string[] = [],
  excludeTargets: GateTarget[] = [],
): Promise<GateResult> {
  // A gate action is a single click plus a short change wait — it
  // needs ~2.5s, not the 6s a full search attempt needs. The old
  // country pick's 6000ms gate starved on exactly this: the search
  // step starts late in the render (load + cookie passes + settles
  // burn most of the 20s), so by the time the toggle had fired the
  // pick was refused for lack of budget.
  if (remainMs() < 2500) return null;
  let scan: GateScanResult;
  try {
    scan = (await page.evaluate(scanGateControls)) as GateScanResult;
  } catch {
    return null;
  }
  const action = selectGateAction(scan, searchTerm, gateOpened, page.url(), excludeLabels, excludeTargets);
  if (!action) return null;
  const startUrl = page.url();
  const startLen = await textLength(page);
  let done = false;
  if (action.kind === 'select') {
    try {
      done = (await page.evaluate(pickSelectOption, action.index, action.optionIndex ?? 0)) as boolean;
    } catch {
      done = false;
    }
  } else {
    let handle: SearchableHandle | null = null;
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
          // Disposal is housekeeping, never load-bearing.
        }
      }
    }
  }
  if (!done) return null;
  if (action.target === 'us') onCountry?.(action.label);
  onGate?.(action.label);
  await waitForChange(page, remainMs, startUrl, startLen, 2500);
  await waitForDomStable(page, remainMs, 2000, 500);
  if (isBoardUrl(page.url())) return 'board';
  if (action.target === 'open') return 'opened';
  // A pick that navigated chose its destination page (the country
  // pick lands on /go/Search-Jobs-US/) — the caller must not submit
  // a search there, or the empty submit replaces the destination
  // with the portal's context-free search (Foundever round 12: the
  // global /search/ page returned Budapest roles).
  if (page.url() !== startUrl) return 'navigated';
  return 'picked';
}

/** One search attempt on the CURRENT page: re-scan (a previous submit
 *  may have navigated), pick the box, refuse board actions, submit by
 *  typing + Enter, and — only if that changes nothing and a submit
 *  button was found — click the button. Then a short settle. */
async function attemptSearch(
  page: SearchablePage,
  term: string,
  remainMs: () => number,
): Promise<AttemptResult> {
  let info: SearchFormInfo;
  try {
    info = (await page.evaluate(scanSearchForm)) as SearchFormInfo;
  } catch {
    return 'failed';
  }
  const sel = selectSearchInput(info);
  if (!sel) return 'no-form';
  if (sel.formAction && !isSearchActionAllowed(sel.formAction, page.url())) return 'no-form';
  if (sel.formAction && isSiteSearchAction(sel.formAction, page.url())) return 'no-form';
  // Baselines are captured BEFORE the submit — a client-side router
  // can navigate during the submit itself, and capturing after would
  // miss the change and burn the whole wait cap.
  const startUrl = page.url();
  const startLen = await textLength(page);
  if (!(await submitViaEnter(page, sel, term))) return 'failed';
  let changed = await waitForChange(page, remainMs, startUrl, startLen, 2500);
  if (!changed && sel.button) {
    const midUrl = page.url();
    const midLen = await textLength(page);
    if (await clickButton(page, sel.button.index)) {
      changed = await waitForChange(page, remainMs, midUrl, midLen, 8000);
    }
  }
  await waitForDomStable(page, remainMs, 4000, 500);
  if (isBoardUrl(page.url())) return 'board';
  return 'settled';
}

type GatesAfterSearchResult = 'searched' | 'no-form' | 'board-redirect' | 'picked' | null;

/** Drive gates AFTER the search submits settled with no listings (or
 *  the term retry found no box): a gate may still be standing behind
 *  the box that was submitted — Omni's header search submits to the
 *  site's ?s= page while the country gate sits untouched on it, and
 *  the term retry only re-submits the same site search (2026-11-12
 *  local round: both Omni fixtures ended no-form with the gate never
 *  driven). Up to three gate actions (an opener, then the pick, then
 *  the next gate), with a listings check after each. A navigating
 *  pick is terminal: the pick chose its destination, and a submit
 *  there would reset the context it just established (the same rule
 *  as the no-form branch). Null when there is no gate to drive — the
 *  caller then returns the search outcome it already had.
 *  'picked' when a gate was driven but no listings appeared: the
 *  caller re-submits, because the submits ran before the gate and
 *  the portal may need the gate's filter first. A gate
 *  action that navigates lands on a FRESH page: the opener/toggle
 *  exclusion is about the page the gate opened on, not this new one,
 *  so gateOpened resets when the URL changes (Sitel: the gate opener
 *  IS the link to the portal, and the portal's own "Find a job in
 *  your country" button must open). Never throws. */
async function driveGatesAfterSearch(
  page: SearchablePage,
  remainMs: () => number,
  searchTerm: string,
  onCountry?: (label: string) => void,
  onGate?: (label: string) => void,
): Promise<GatesAfterSearchResult> {
  let gateOpened = false;
  // Labels already driven on this page: a non-navigating pick that
  // revealed no listings is a dead end, and selectGateAction is told
  // to skip it so the next round drives the NEXT gate (a department
  // filter behind the country pick) instead of clicking the same
  // button again. droveGate records that a gate fired at all: the
  // caller re-submits after it, because the submits ran before the
  // gate and the portal may need the gate's filter first (Alorica's
  // bling-ai portal, 2026-11-12 canary). droveCountry records that
  // a country pick fired: after it, language buttons are excluded —
  // a language pick after a country pick switches the UI language,
  // it does not filter jobs, and the loop would otherwise click
  // 'English', then 'French', then 'Spanish' and burn the
  // re-submit budget (same canary, local round).
  const drivenLabels: string[] = [];
  let droveGate = false;
  let droveCountry = false;
  for (let round = 0; round < 3; round++) {
    const roundUrl = page.url();
    let roundLabel: string | null = null;
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
      droveCountry ? ['english'] : [],
    );
    if (gated === 'board') return 'board-redirect';
    if (gated === 'navigated') {
      gateOpened = true;
      await waitForDomStable(page, remainMs, 3000, 500);
      if (await listingsNow(page)) return 'searched';
      if (await jobLinksNow(page)) return 'searched';
      return 'no-form';
    }
    if (gated) {
      droveGate = true;
      if (roundLabel) drivenLabels.push(roundLabel);
      if (page.url() !== roundUrl) gateOpened = false;
      else gateOpened = true;
      await waitForDomStable(page, remainMs, 3000, 500);
      if (await listingsNow(page)) return 'searched';
      if (await jobLinksNow(page)) return 'searched';
      continue;
    }
    return droveGate ? 'picked' : null;
  }
  await waitForDomStable(page, remainMs, 3000, 500);
  if (await listingsNow(page)) return 'searched';
  if (await jobLinksNow(page)) return 'searched';
  return droveGate ? 'picked' : null;
}

/** The term ladder: submit search terms in order until listings
 *  appear. Depth fix (2026-11-14): after the resume role term,
 *  "remote" (many portals return nothing on an empty submit and
 *  match on keyword — it is the highest-signal single term for
 *  this board), then "customer service" (when the resume's first
 *  two terms are a title variant the portal doesn't index, e.g.
 *  "client services"). "customer service" is skipped when the
 *  resume term already is that phrase. Each step needs ≥6s
 *  remaining, the same gate attemptSearch needs. When every term
 *  ran without listings and a separate location box exists, fill it
 *  with "Remote" and re-submit the last term tried once — the
 *  portal-native equivalent of the location rule, and what a human
 *  does on these portals. onTermHit reports the term that produced
 *  listings (or the location-fill re-submit's term), so the caller
 *  can record which rung of the ladder hit. Never throws. */
async function runTermLadder(
  page: SearchablePage,
  searchTerm: string,
  remainMs: () => number,
  onTermHit?: (term: string) => void,
): Promise<PortalSearchOutcome> {
  const terms: string[] = [];
  if (searchTerm) terms.push(searchTerm);
  terms.push('remote');
  if (!searchTerm || !/^\s*customer service\s*$/i.test(searchTerm)) {
    terms.push('customer service');
  }
  let lastTerm: string | null = null;
  for (const term of terms) {
    if (remainMs() < 6000) return 'no-results';
    lastTerm = term;
    const attempt = await attemptSearch(page, term, remainMs);
    if (attempt === 'board') return 'board-redirect';
    if (attempt === 'no-form') return 'no-form';
    if (attempt === 'failed') return 'submit-failed';
    if (await listingsNow(page)) {
      onTermHit?.(term);
      return 'searched';
    }
  }
  // Location fill: a portal with a separate location box may need
  // "Remote" in it before its search returns anything. One fill +
  // one re-submit of the last term tried, time permitting. Never
  // runs after a navigating gate pick (that rule lives in the
  // caller — this ladder only runs on the page the submits ran on).
  if (lastTerm && remainMs() >= 6000) {
    let info: SearchFormInfo;
    try {
      info = (await page.evaluate(scanSearchForm)) as SearchFormInfo;
    } catch {
      return 'no-results';
    }
    const loc = selectLocationInput(info);
    if (loc && (await fillLocationInput(page, loc.index))) {
      const attempt = await attemptSearch(page, lastTerm, remainMs);
      if (attempt === 'board') return 'board-redirect';
      if (attempt === 'failed') return 'submit-failed';
      if (await listingsNow(page)) {
        onTermHit?.(lastTerm);
        return 'searched';
      }
    }
  }
  return 'no-results';
}

/** The search step: on a rendered careers page that shows no listings,
 *  submit the portal's own search (empty first, then the resume role
 *  term, then the term ladder — "remote", then "customer service" —
 *  and a "Remote" location fill) and wait for results. Never throws
 *  — every failure mode is an outcome the caller can ignore and move
 *  on from. */
export async function tryPortalSearch(
  page: SearchablePage,
  searchTerm: string,
  deadlineMs: number,
  onToggle?: (label: string) => void,
  onCountry?: (label: string) => void,
  onGate?: (label: string) => void,
  onTermHit?: (term: string) => void,
): Promise<PortalSearchOutcome> {
  const remainMs = (): number => deadlineMs - Date.now();
  // A search needs at least ~6s: scan + submit + results wait. Less
  // than that, leave the rendered page as it loaded.
  if (remainMs() < 6000) return 'skipped-time';
  if (await listingsNow(page)) return 'has-listings';
  const first = await attemptSearch(page, '', remainMs);
  if (first === 'board') return 'board-redirect';
  if (first === 'no-form') {
    // No qualifying box — but the box may live behind a toggle
    // ("Search jobs" expands the form) and/or behind a gate: a
    // country picker, a region/department/language dropdown, a
    // modal, tabs. Drive through them in order, re-scanning after
    // each step: one toggle, then up to three gate actions (an
    // opener click, then the option pick, then the next gate — a
    // page can stack a country picker in front of a department
    // filter). Gates are tried FIRST in every round: a gate
    // establishes the page's context (country, region, department),
    // and a search submit on the gate's destination page would
    // reset it — Foundever round 12: the empty submit after the US
    // pick landed on the global /search/ page and returned Budapest
    // roles, while round 13 (no submit) returned the exact US roles
    // Eric found by hand. A navigating pick is therefore terminal
    // for the search step: settle, harvest what the destination
    // shows (listings, or bare job cards under a count format the
    // detector does not know), or stop — the render loop retries
    // the next target, which is the right fallback. A non-navigating
    // pick or an opener keeps the loop going: more gates may be
    // stacked, or the revealed box gets its submit below. A page
    // with no gate at all still reports no-form, and a failed toggle
    // still reports no-form.
    const toggled = await clickSearchToggle(page, remainMs, onToggle);
    if (toggled === 'board') return 'board-redirect';
    let gateOpened = toggled === 'toggled';
    let ranSearch = false;
    // Same rule as driveGatesAfterSearch below: once a country pick
    // has fired, language buttons are excluded from later rounds —
    // they switch the UI language, they do not filter jobs.
    let droveCountry = false;
    for (let round = 0; round < 4; round++) {
      const roundUrl = page.url();
      const gated = await resolveGateOnce(
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
        droveCountry ? ['english'] : [],
      );
      if (gated === 'board') return 'board-redirect';
      if (gated === 'navigated') {
        // The pick chose its destination page. Let it settle, then
        // harvest what it shows — never submit there.
        gateOpened = true;
        await waitForDomStable(page, remainMs, 3000, 500);
        if (await listingsNow(page)) return 'searched';
        if (await jobLinksNow(page)) return 'searched';
        return 'no-form';
      }
      if (gated) {
        // A non-navigating pick or an opener: let the page settle,
        // then check for listings before anything else — cards may
        // be visible under a count format the detector does not
        // know, and a submit over them would only replace the page.
        // A gate action that navigated landed on a FRESH page: the
        // opener/toggle exclusion is about the page the gate opened
        // on, not this new one — its own "Find a job" button is a
        // legitimate opener, not a re-click of the one that just
        // fired (Sitel: the gate opener IS the link to the portal,
        // and the portal's own "Find a job in your country" button
        // must open, 2026-11-12 local round).
        if (page.url() !== roundUrl) gateOpened = false;
        else gateOpened = true;
        await waitForDomStable(page, remainMs, 3000, 500);
        if (await listingsNow(page)) return 'searched';
        if (await jobLinksNow(page)) return 'searched';
        continue;
      }
      const attempt = await attemptSearch(page, '', remainMs);
      if (attempt === 'board') return 'board-redirect';
      if (attempt === 'failed') return 'submit-failed';
      if (attempt !== 'no-form') {
        ranSearch = true;
        break;
      }
      // No box and no gate: nothing more to try on this page.
      return 'no-form';
    }
    if (!ranSearch) {
      // The loop ran out of rounds on gates alone (stacked gates,
      // each revealing the next) — one final scan before concluding
      // no-form.
      await waitForDomStable(page, remainMs, 3000, 500);
      if (await listingsNow(page)) return 'searched';
      if (await jobLinksNow(page)) return 'searched';
      const attempt = await attemptSearch(page, '', remainMs);
      if (attempt === 'board') return 'board-redirect';
      if (attempt === 'failed') return 'submit-failed';
      if (attempt === 'no-form') return 'no-form';
    }
    if (await listingsNow(page)) return 'searched';
    // The empty search ran but showed nothing — run the term ladder
    // (resume term, then "remote", then "customer service", then a
    // "Remote" location fill + last-term re-submit).
    return runTermLadder(page, searchTerm, remainMs, onTermHit);
  }
  if (first === 'failed') return 'submit-failed';
  if (await listingsNow(page)) return 'searched';
  // Empty search showed nothing (some portals require a keyword).
  // One retry with the resume's role term, time permitting — then,
  // before concluding, drive any gate still standing behind the box
  // that was submitted (Omni: the box was the site's header search,
  // not the portal's; the country gate is untouched, and the term
  // retry only re-submits the same site search, 2026-11-12 local
  // round). The gate runs last, so a working term retry is never
  // pre-empted by a gate pick, and no submit ever follows a pick.
  // The empty search ran but showed nothing — run the term ladder
  // (resume term, then "remote", then "customer service", then a
  // "Remote" location fill + last-term re-submit) before concluding,
  // then drive any gate still standing behind the box (below).
  const tail = await runTermLadder(page, searchTerm, remainMs, onTermHit);
  if (tail === 'searched') return 'searched';
  const gated = await driveGatesAfterSearch(page, remainMs, searchTerm, onCountry, onGate);
  if (gated === 'board-redirect') return 'board-redirect';
  if (gated === 'searched') return 'searched';
  if (gated === 'no-form') return 'no-form';
  if (gated === 'picked') {
    // A gate was driven after the submits (a country filter the
    // portal needed before its search returns anything) but no
    // listings appeared yet: the submits ran BEFORE the gate, so
    // re-run them once on the gated page — never after a navigating
    // pick ('no-form' above), where a submit would reset the
    // context the pick just established (Alorica's bling-ai portal,
    // 2026-11-12 canary: both submits returned 0 roles before the
    // "United States" filter was picked).
    if (remainMs() < 6000) return 'no-results';
    const retry = await attemptSearch(page, '', remainMs);
    if (retry === 'board') return 'board-redirect';
    if (retry === 'failed') return 'submit-failed';
    if (await listingsNow(page)) return 'searched';
    if (!searchTerm || remainMs() < 6000) return 'no-results';
    const retryTerm = await attemptSearch(page, searchTerm, remainMs);
    if (retryTerm === 'board') return 'board-redirect';
    if (retryTerm === 'failed') return 'submit-failed';
    return (await listingsNow(page)) ? 'searched' : 'no-results';
  }
  return tail;
}
