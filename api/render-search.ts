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
 * closures over module state. The selection logic runs in Node on the
 * serialized descriptors, so the offline test suite can drive it with
 * canned data and a fake page — no real browser needed there.
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
  let resultsText = false;
  for (const m of bodyText.matchAll(/([\d,]+)\s+(jobs?|results?|openings?|positions?)\b/gi)) {
    if (parseInt(m[1].replace(/,/g, ''), 10) > 0) {
      resultsText = true;
      break;
    }
  }
  return { jobLinks, resultsText };
}

/* ------------------------------------------------------------------ */
/* Selection (pure — runs in Node on the scan data)                    */
/* ------------------------------------------------------------------ */

/** Score a visible text input as the portal's keyword box. Location
 *  boxes score negative (they also say "search"); a bare input with no
 *  job-search signal scores too low to trust. */
function scoreSearchInput(d: SearchInputDescriptor): number {
  if (
    ['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset'].includes(
      d.type,
    )
  ) {
    return -100;
  }
  const signal = `${d.name} ${d.id} ${d.placeholder} ${d.ariaLabel}`.toLowerCase();
  let score = 0;
  if (/location|zip|city|state|postal|radius|distance/.test(signal)) score -= 3;
  if (/keyword/.test(signal)) score += 4;
  if (/\bsearch\b/.test(signal)) score += 2;
  if (/job|title|\bwhat\b|role|position/.test(signal)) score += 2;
  if (d.name === 'q' || d.id === 'q') score += 2;
  if (d.type === 'search') score += 1;
  if (d.formIndex >= 0) score += 1;
  return score;
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
    nearest(list.filter((b) => /search|find/i.test(`${b.text} ${b.ariaLabel}`)));
  const button =
    byText(sameForm) ??
    nearest(sameForm.filter((b) => b.type === 'submit')) ??
    nearest(
      info.buttons.filter(
        (b) => b.visible && /search jobs|find jobs/i.test(`${b.text} ${b.ariaLabel}`),
      ),
    ) ??
    // A bare "Search" button (Walmart, Phenom): the portal's own
    // submit, labelled with nothing more specific.
    nearest(
      info.buttons.filter((b) => b.visible && /\bsearch\b/i.test(`${b.text} ${b.ariaLabel}`)),
    ) ??
    null;
  const formAction = best.formIndex >= 0 ? info.forms[best.formIndex]?.action ?? '' : '';
  return { input: best, button, formAction };
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

/** The search step: on a rendered careers page that shows no listings,
 *  submit the portal's own search (empty first, then the resume role
 *  term) and wait for results. Never throws — every failure mode is an
 *  outcome the caller can ignore and move on from. */
export async function tryPortalSearch(
  page: SearchablePage,
  searchTerm: string,
  deadlineMs: number,
): Promise<PortalSearchOutcome> {
  const remainMs = (): number => deadlineMs - Date.now();
  // A search needs at least ~6s: scan + submit + results wait. Less
  // than that, leave the rendered page as it loaded.
  if (remainMs() < 6000) return 'skipped-time';
  if (await listingsNow(page)) return 'has-listings';
  const first = await attemptSearch(page, '', remainMs);
  if (first === 'board') return 'board-redirect';
  if (first === 'no-form') return 'no-form';
  if (first === 'failed') return 'submit-failed';
  if (await listingsNow(page)) return 'searched';
  // Empty search showed nothing (some portals require a keyword).
  // One retry with the resume's role term, time permitting.
  if (!searchTerm || remainMs() < 6000) return 'no-results';
  const second = await attemptSearch(page, searchTerm, remainMs);
  if (second === 'board') return 'board-redirect';
  if (second === 'no-form') return 'no-form';
  if (second === 'failed') return 'submit-failed';
  return (await listingsNow(page)) ? 'searched' : 'no-results';
}
