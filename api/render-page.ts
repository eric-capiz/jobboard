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

/** Whether a cookie banner is VISIBLY covering the page (an element
 *  carrying banner phrases with a non-zero visible box). Runs in
 *  the browser via page.evaluate, so it must stay self-contained:
 *  no imports, no closures over module state. The text check above
 *  cannot say this — the banner's copy can stay in the DOM after
 *  the banner hides. Used twice: dismissBanner decides whether a
 *  reload is needed at all, and the final result records whether
 *  the banner is really up at the end. */
export function bannerVisibleInPage(): boolean {
  const phrases = /we use cookies|cookie preferences|accept (all )?cookies|this site uses cookies|we value your privacy/i;
  const els = Array.from(document.querySelectorAll('body *'));
  for (const el of els) {
    const t = (el as HTMLElement).innerText || '';
    if (t.length === 0 || t.length > 500 || !phrases.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    try {
      if (getComputedStyle(el).visibility === 'hidden') continue;
    } catch {
      // No computed style — the box is enough.
    }
    return true;
  }
  return false;
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
  /** The visible button/link labels the accept step last saw
   *  (TAG:text, capped). Empty when the accept step never ran or
   *  saw nothing. A 0-click attempt with a banner up and this list
   *  showing the button's label means the match pattern missed it;
   *  an empty list means the button genuinely was not in the DOM. */
  bannerButtons?: string[];
  /** The label of the element the accept step last clicked (null
   *  when nothing was ever clicked). Foundever's render shows
   *  clicks 1 with the banner still up — this says whether the
   *  click hit the real accept button or another accept-like
   *  element. */
  cookieClickedLabel?: string | null;
  /** Whether a cookie banner is VISIBLY covering the page at the
   *  end of the render (an element carrying banner text with a
   *  non-zero box). bannerPresent is text-based: the banner's copy
   *  can stay in the DOM after the banner hides, so text alone
   *  cannot say the banner is up. When present is true but visible
   *  is false, the click worked and the text is residual. */
  bannerVisible?: boolean;
  /** The label of the search toggle the search step clicked, if
   *  any (null when the step never needed a toggle, or no toggle
   *  matched). Distinguishes "no toggle fired" from "the toggle
   *  revealed a picker, not a search box" (Sitel's country picker). */
  searchToggleClicked?: string | null;
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
  // Labels the accept step last saw (kept across passes).
  let lastAcceptLabels: string[] = [];
  // Label of the element the accept step last clicked.
  let lastClickedLabel: string | null = null;
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
    const tryCookieAccept = async (pg: Page): Promise<{ clicked: boolean; labels: string[]; clickedLabel: string | null }> => {
      try {
        return await pg.evaluate(() => {
          // Buttons can hide in shadow roots (OneTrust renders its
          // banner inside one on some portals): querySelectorAll
          // does not cross shadow boundaries, so walk the tree and
          // collect from every open shadow root, or the button is
          // invisible to the scan even while its text shows in the
          // page (Foundever: banner copy in the sample, 0 clicks).
          const collectButtons = (root: Document | ShadowRoot): HTMLElement[] => {
            const out = Array.from(root.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
            root.querySelectorAll('*').forEach((el) => {
              const sr = (el as HTMLElement).shadowRoot;
              if (sr) out.push(...collectButtons(sr));
            });
            return out;
          };
          const btns = collectButtons(document);
          const isVisible = (b: HTMLElement): boolean => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const textOf = (b: HTMLElement): string => (b.innerText || '').trim();
          // Tier 1: the strict accept — anchored at the start, and
          // the match must end at a word boundary. The old
          // prefix-only pattern matched "Acceptable Use Policy" (a
          // footer link starts with "Accept"); the round-5 '\s*$'
          // anchor over-tightened the other way and missed labels
          // with a trailing glyph. '\b' excludes "Acceptable" (the
          // 't' is followed by 'a', no boundary) while still
          // matching "Accept All Cookies ›".
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
              /^(accept( all)?( cookies)?|allow all( cookies)?|accept & close|i agree|alle akzeptieren|tout accepter|aceptar( todo| las cookies)?)\b/i.test(
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
          // Diagnostic: what the accept step could see — the visible
          // button/link labels, so a live 0-click with a banner up
          // can be told apart (button present but mismatched vs.
          // genuinely absent). Capped; the caller keeps the latest.
          // Accept-like labels come FIRST: the banner is usually
          // last in the DOM, so a flat first-15 cap truncates before
          // reaching it (Sitel: 15 nav labels, banner up, 0 clicks,
          // and no accept label in the list). The first few overall
          // labels follow so the page is still recognizable.
          const allLabels = btns
            .filter(isVisible)
            .map((b) => `${b.tagName}:${textOf(b).replace(/\s+/g, ' ').slice(0, 60)}`)
            .filter((s) => s.length > 'BUTTON:'.length);
          const nearMiss = allLabels.filter((s) => /accept|cookie|consent|agree|allow|opt.?in|got it/i.test(s));
          const labels = [...new Set([...nearMiss.slice(0, 15), ...allLabels.slice(0, 8)])];
          if (!accept) return { clicked: false, labels, clickedLabel: null };
          accept.click();
          // What was clicked, not just what was seen: Foundever's
          // render shows clicks 1 with the banner still up, and the
          // labels list alone cannot say whether the click hit the
          // real accept button or another accept-like element.
          return { clicked: true, labels, clickedLabel: textOf(accept).replace(/\s+/g, ' ').slice(0, 60) };
        }).then((result) => {
          // Only a click updates the label: later no-match calls
          // must not erase what an earlier call clicked (Foundever:
          // clicks 1, clickedLabel null — the last call found
          // nothing and overwrote it).
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
        if (!(await tryCookieAccept(pg)).clicked) break;
        clicked = true;
        await waitForDomStable(pg, remain, 2000, 500);
      }
      if (!clicked) return false;
      // Reload ONLY when the banner is still visibly up after the
      // click passes. A click hides the banner for THIS page load;
      // reloading re-shows it when consent does not persist across
      // the load — Foundever: the click lands on "Accept All
      // Cookies" and the banner is back up at the end of the render
      // (2026-11-12 canary). When the banner is already down, skip
      // the reload entirely: the search runs on the clicked page
      // with the banner down, and the budget the reload would have
      // burned stays available for the search.
      let bannerStillUp = false;
      try {
        bannerStillUp = (await pg.evaluate(bannerVisibleInPage)) as boolean;
      } catch {
        bannerStillUp = true;
      }
      if (!bannerStillUp) return true;
      if (remain() <= 12000) return true;
      try {
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1000, remain()) });
      } catch {
        // Keep the current page — it may already show content.
      }
      await waitForDomStable(pg, remain, 3000, 500);
      for (let pass = 0; pass < 2 && remain() > 3000; pass++) {
        if (!(await tryCookieAccept(pg)).clicked) break;
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
    // A FINAL accept attempt right before the search — no reload
    // after it. Consent banners can inject late (Foundever's banner
    // text appears in the final sample while all earlier passes saw
    // nothing), and a last click is what clears the search box for
    // the scan. The click hides the banner synchronously, so no
    // reload is needed — the search runs on the now-visible form.
    if (remain() > 1000) await tryCookieAccept(page);
    const searchStart = Date.now();
    // The label of the search toggle the step clicked, if any (a
    // country-picker entry, not a search box, still counts: Sitel's
    // no-form may mean the toggle revealed a picker, not nothing).
    let searchToggleClicked: string | null = null;
    const searchOutcome = await tryPortalSearch(page, searchTerm, deadline, (label) => {
      searchToggleClicked = label;
    });
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
      return { html: '', searchOutcome, searchMs, renderedUrl: page.url(), cookieClicks, searchToggleClicked };
    }
    const html = await page.content();
    // Visibility, not just text: the banner's copy can stay in the
    // DOM after the banner hides (Foundever: banner text in the
    // sample with a click already landed). An element carrying the
    // banner phrases with a non-zero visible box means the banner is
    // really up; text alone does not.
    let bannerVisible = false;
    try {
      bannerVisible = (await page.evaluate(bannerVisibleInPage)) as boolean;
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
