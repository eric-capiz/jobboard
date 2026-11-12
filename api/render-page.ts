/* Render a careers page in a real browser — the JS fallback for
 * Find Jobs.
 *
 * Most big employers render their job lists with JavaScript (Workday /
 * Lever / Ashby / Greenhouse-style boards): the plain-HTML reader
 * fetches the page shell and finds zero listings, so 84.6% of the
 * roster yields nothing. This loads the SAME careers-page URL in a
 * headless Chromium and returns the rendered DOM HTML, which the
 * existing extractors in find-jobs.ts then parse exactly like static
 * HTML. The matcher, scoring, and location rules are untouched. After
 * the page settles, the portal search step (render-search.ts) runs on
 * the same page: a careers portal that shows no jobs until a search is
 * submitted gets its own search box filled and submitted — empty
 * first (all jobs), then a resume role term — and the returned HTML is
 * the post-search results page. A page that already lists jobs is left
 * alone.
 *
 * SOURCE DISCIPLINE: this module only ever opens the URL it is given
 * — the caller (find-jobs.ts) only ever passes the company's own
 * careers-page URL, and only after the plain-HTML pass found nothing
 * there. No board domain or ATS API is ever opened as a source: if the
 * page redirects onto a board domain, the render returns an empty-HTML
 * result (so the caller still sees what ended it) and the page counts
 * as no listings. The only board contact remains the
 * apply link on a listing found on the business page.
 *
 * WHERE IT RUNS: inside the same Vercel serverless function, via
 * @sparticuz/chromium-min + puppeteer-core. The npm package is only a
 * 46KB loader — the Chromium binary is NOT in the deployment, so the
 * function stays far under Vercel's 250MB uncompressed limit. On the
 * first render of a warm instance the loader downloads the pinned
 * pack (~70MB) from the @sparticuz/chromium GitHub releases into /tmp
 * and extracts it there; later renders on the same instance reuse it.
 * $0: the packages are MIT, the download is a free public release.
 *
 * LIMITS (Hobby): maxDuration is 60s (set on the calling functions),
 * memory 1024MB — the loader's own minimum is 512MB, so Chromium
 * runs single-process with images/fonts/media blocked. A cold first
 * render (download + launch + page JS) can take ~30s; warm renders
 * ~5-10s. The caller enforces a per-render timeout and a
 * per-invocation render budget, so a slow page can never eat a chunk.
 *
 * KILL-SWITCH: JOBBOARD_NO_RENDER=1 disables the fallback without a
 * code push — and keeps the offline test suite hermetic, since its
 * stubbed fetch has no real browser behind it.
 */

import chromium from '@sparticuz/chromium-min';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { isBoardUrl } from './finder-lib.js';
import {
  scanSearchForm,
  summarizeScan,
  tryPortalSearch,
  waitForDomStable,
  type PortalSearchOutcome,
  type SearchFormInfo,
  type SearchScanSummary,
} from './render-search.js';

/** The Chromium binary pack for x86_64, pinned to the loader version
 *  in package.json. Vercel functions run on x86_64 Linux. */
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar';

/** Hard cap on one render: navigation + JS settle, end to end. */
const RENDER_TIMEOUT_MS = 20000;
/** Cap on waiting for the rendered listings to settle (see below). */
const SETTLE_CAP_MS = 12000;

/** Whether a page's rendered HTML still carries a cookie-consent
 *  banner — OneTrust's banner text is unmistakable, and it is the
 *  only thing a banner-covered page renders (Foundever's sample was
 *  banner-only text). Checked on the final HTML so the next canary
 *  can tell "clicked but the banner came back" from "never found". */
function bannerTextPresent(html: string): boolean {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return /we use cookies|cookie preferences|accept all cookies|consent preferences/i.test(text);
}

export interface RenderPageResult {
  /** The rendered DOM HTML — the post-search results page when the
   *  portal search ran. Empty when the render ended on a board domain
   *  (no source to extract from). */
  html: string;
  /** The portal-search outcome, or null when the search step never
   *  ran (render failed before it, or the load itself redirected
   *  onto a board). This is what makes the search step observable:
   *  the caller can tell "search ran and found nothing" apart from
   *  "the search never ran". */
  searchOutcome: PortalSearchOutcome | null;
  /** Why the search found no box — the scan summary from the
   *  rendered page (inputs seen, visible inputs, best score,
   *  buttons). Present only when the search ended no-form, so a
   *  live no-form can be told apart: no inputs vs. unqualifying
   *  inputs vs. board action. */
  searchScan?: SearchScanSummary;
  /** Milliseconds spent inside the portal search step (0 when it
   *  never ran). */
  searchMs: number;
  /** The page URL after load + search — the results page when the
   *  search navigated. '' when no page was ever loaded. */
  renderedUrl: string;
  /** Why the render failed, when it did — 'browser-unavailable'
   *  (launch timed out or no browser) or 'render-failed' (navigation
   *  or load threw). Undefined when the render succeeded or the page
   *  was reached. The caller surfaces this instead of a bare null so
   *  a fast render death can be told apart from 'never attempted'. */
  renderError?: string;
  /** Cookie-banner accept clicks that landed during this render (0
   *  when no banner button was found) and whether a cookie banner
   *  was still covering the page when the render ended. The
   *  Foundever/Sitel diagnostic (2026-11-12): clicks 0 means the
   *  button was never found; clicks > 0 with the banner still
   *  present means the click landed but the banner came back. */
  cookieClicks?: number;
  bannerPresent?: boolean;
}

export type RenderPageFn = (
  url: string,
  searchTerm?: string,
) => Promise<RenderPageResult | null>;

/** One browser per warm instance, shared by every render in it.
 *  A failed launch clears the promise so the next render retries. */
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
      // Text extraction only — graphics off, never screenshots.
      chromium.setGraphicsMode = false;
      return puppeteer.launch({
        args: chromium.args,
        defaultViewport: { width: 800, height: 600 },
        executablePath,
        headless: 'shell',
      });
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function renderDisabled(): boolean {
  return process.env.JOBBOARD_NO_RENDER === '1';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([
    promise.then(
      (value) => {
        clearTimeout(timer);
        return value as T | null;
      },
      () => {
        clearTimeout(timer);
        return null;
      },
    ),
    timeout,
  ]);
}

/** Load url in a real browser and return the rendered DOM HTML, or
 *  null when the page cannot be rendered (launch/download failure,
 *  navigation timeout, kill-switch). Never throws.
 *  After the page settles, the portal search step runs (see
 *  render-search.ts): a search-gated careers page gets its own search
 *  submitted — empty first, then `searchTerm` — and the HTML returned
 *  is the post-search results page. A page that already shows listings
 *  is left alone; a board redirect anywhere in the flow returns an
 *  empty-HTML result (not null) so the caller still sees the outcome
 *  that ended the render. The search outcome, its milliseconds, and
 *  the final URL ride on the result so the step is observable from
 *  the API response instead of silent. */
export async function renderPageHtml(url: string, searchTerm: string = '', timeoutMs: number = RENDER_TIMEOUT_MS): Promise<RenderPageResult | null> {
  if (renderDisabled()) return null;
  const deadline = Date.now() + timeoutMs;
  const remain = (): number => deadline - Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;
  let cookieClicks = 0;
  try {
    browser = await withTimeout(getBrowser(), remain());
    if (!browser || remain() <= 0) {
      return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: '', renderError: 'browser-unavailable', cookieClicks };
    }
    page = await browser.newPage();
    // A standard Chrome UA matching the pinned engine (Chromium
    // 153): the old 'JobBoard Finder' UA advertised a bot outright,
    // and WAFs that sniff UA/version mismatches reject the session.
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    // Locale-detecting portals default to the browser's language;
    // state English explicitly so a US employer's portal renders its
    // en_US variant (Foundever defaulted to de_DE, 2026-11-12).
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    // The listings are text: block the heavyweight resource types so
    // slow boards settle faster. Stylesheets stay — some boards gate
    // their render on CSS load.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') void req.abort();
      else void req.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, remain()) });
    // Cookie banners cover some portals' search boxes (Foundever's
    // render is banner-only text until accepted) and can intercept
    // the click on the box itself. Best-effort "Accept cookies"
    // clicks, up to two passes — some banners stack a second consent
    // dialog behind the first. Never throws; a page without a banner
    // just skips it.
    const tryCookieAccept = async (pg: Page): Promise<boolean> => {
      try {
        return await pg.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
          const isVisible = (b: HTMLElement): boolean => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const textOf = (b: HTMLElement): string => (b.innerText || '').trim();
          // Tier 1: the strict accept — the whole label, anchored at
          // both ends. The old prefix-only pattern matched "Acceptable
          // Use Policy" (a footer link): it starts with "Accept", so
          // find() returned the footer link and the banner stayed up.
          // Tier 2: a contains-match for the same idea in other
          // languages ("Alle Cookies akzeptieren" — Foundever's
          // German banner — does not start with "Alle akzeptieren",
          // so the anchored pattern misses it), still guarded against
          // "Acceptable..." labels. The loose tier only scans real
          // buttons and links: a [role="button"] div can be a whole
          // page section whose text merely contains 'accept', and
          // clicking it would navigate somewhere unrelated.
          const strict = btns.find(
            (b) =>
              isVisible(b) &&
              /^(accept( all)?( cookies)?|allow all( cookies)?|accept & close|i agree|alle akzeptieren|tout accepter|aceptar( todo| las cookies)?)\s*$/i.test(
                textOf(b),
              ),
          );
          const loose = btns.find(
            (b) =>
              isVisible(b) &&
              (b.tagName === 'BUTTON' || b.tagName === 'A') &&
              !/^acceptable/i.test(textOf(b)) &&
              /accept|akzeptieren|tout accepter|aceptar/i.test(textOf(b)),
          );
          const accept = strict ?? loose ?? null;
          if (!accept) return false;
          accept.click();
          return true;
        }).then((clicked) => {
          if (clicked) cookieClicks += 1;
          return clicked;
        });
      } catch {
        return false;
      }
    };
    // Dismiss a cookie banner: click the accept button (up to two
    // passes for stacked dialogs), reload so the consent takes effect
    // once, then check again — a reload can re-show the banner
    // (consent not persisted) and a second dialog can sit behind the
    // first. A click hides the banner itself even without a second
    // reload, so the post-reload passes only click. Settles after a
    // reload are short (3s): the render budget is 20s and the search
    // step needs ≥6s left, so a long settle starves the search —
    // exactly Foundever's skipped-time outcome (2026-11-12).
    const dismissBanner = async (pg: Page): Promise<boolean> => {
      let clicked = false;
      for (let pass = 0; pass < 2 && remain() > 3000; pass++) {
        if (!(await tryCookieAccept(pg))) break;
        clicked = true;
        await waitForDomStable(pg, remain, 2000, 500);
      }
      if (!clicked) return false;
      try {
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1000, remain()) });
      } catch {
        // Keep the current page — it may already show content.
      }
      await waitForDomStable(pg, remain, 3000, 500);
      for (let pass = 0; pass < 2 && remain() > 3000; pass++) {
        if (!(await tryCookieAccept(pg))) break;
        await waitForDomStable(pg, remain, 2000, 500);
      }
      return true;
    };
    // Accept EARLY — right after a short settle, while the 20s
    // budget is still full. The old order settled first (up to 12s)
    // and the accept step's remain() > 8000 gate then starved on
    // slow pages, so the click never ran (Foundever, 2026-11-12:
    // renderMs 16.7s, banner still up, 0 visible inputs). A consent
    // cookie often only takes effect on the NEXT load, so an accepted
    // banner reloads the page once and the portal's content renders.
    await waitForDomStable(page, remain, 2000, 500);
    // A redirect off the business site onto a board is not a source.
    if (isBoardUrl(page.url())) {
      return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: page.url(), cookieClicks };
    }
    let dismissedEarly = await dismissBanner(page);
    if (!dismissedEarly) {
      // No banner accepted early: the full settle (the page's own
      // JS may still need it — a banner can inject after the early
      // passes), then one more dismiss attempt for a late banner.
      // The old remain() > 8000 gate starved this attempt on slow
      // pages; a click is cheap, so the gate is now 3000.
      // Let the board's JS settle. The signal is the rendered text
      // itself: poll the page's visible text until it stops changing for
      // two polls, or the cap hits. Network-idle is the wrong signal —
      // boards keep polling analytics (never idle, so the whole budget
      // burns) or go idle before their jobs request fires (so the
      // listings are missed). A page whose text never stabilises (live
      // counters, clocks) just runs to the cap and proceeds.
      await waitForDomStable(page, remain, SETTLE_CAP_MS, 1000);
      if (isBoardUrl(page.url())) {
        return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: page.url(), cookieClicks };
      }
      if (remain() > 3000) {
        await dismissBanner(page);
      }
    }
    // Search-portal step: the page may be an empty search shell that
    // shows no jobs until a search is submitted (Walmart, FedEx, CVS
    // ...). The step runs on this same page only — it never navigates
    // anywhere the page itself doesn't take it, and a board redirect
    // out of it returns an empty result, like the load redirect above.
    const searchStart = Date.now();
    const searchOutcome = await tryPortalSearch(page, searchTerm, deadline);
    const searchMs = Date.now() - searchStart;
    // No-form diagnosis: what the scan actually saw on the page, so
    // a live no-form can be told apart (no inputs vs. unqualifying
    // inputs vs. board action). Only computed on no-form — the
    // common paths need no extra evaluate.
    let searchScan: SearchScanSummary | undefined;
    if (searchOutcome === 'no-form') {
      try {
        searchScan = summarizeScan((await page.evaluate(scanSearchForm)) as SearchFormInfo);
      } catch {
        searchScan = undefined;
      }
    }
    if (searchOutcome === 'board-redirect') {
      return { html: '', searchOutcome, searchMs, renderedUrl: page.url(), cookieClicks };
    }
    const html = await page.content();
    return {
      html,
      searchOutcome,
      searchMs,
      renderedUrl: page.url(),
      searchScan,
      cookieClicks,
      bannerPresent: bannerTextPresent(html),
    };
  } catch {
    // A failed render still reports WHY instead of a bare null, so the
    // caller can tell a fast render death (host reset, launch failure)
    // apart from a render that never ran.
    return { html: '', searchOutcome: null, searchMs: 0, renderedUrl: '', renderError: 'render-failed', cookieClicks };
  } finally {
    try {
      await page?.close();
    } catch {
      // The page is already gone — nothing to clean up.
    }
  }
}
