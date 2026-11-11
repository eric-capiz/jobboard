/* Render a careers page in a real browser — the JS fallback for
 * Find Jobs.
 *
 * Most big employers render their job lists with JavaScript (Workday /
 * Lever / Ashby / Greenhouse-style boards): the plain-HTML reader
 * fetches the page shell and finds zero listings, so 84.6% of the
 * roster yields nothing. This loads the SAME careers-page URL in a
 * headless Chromium and returns the rendered DOM HTML, which the
 * existing extractors in find-jobs.ts then parse exactly like static
 * HTML. The matcher, scoring, and location rules are untouched.
 *
 * SOURCE DISCIPLINE: this module only ever opens the URL it is given
 * — the caller (find-jobs.ts) only ever passes the company's own
 * careers-page URL, and only after the plain-HTML pass found nothing
 * there. No board domain or ATS API is ever opened as a source: if the
 * page redirects onto a board domain, the render returns null and the
 * page counts as no listings. The only board contact remains the
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

/** The Chromium binary pack for x86_64, pinned to the loader version
 *  in package.json. Vercel functions run on x86_64 Linux. */
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar';

/** Hard cap on one render: navigation + JS settle, end to end. */
const RENDER_TIMEOUT_MS = 20000;
/** Cap on waiting for the rendered listings to settle (see below). */
const SETTLE_CAP_MS = 12000;

export type RenderPageFn = (url: string) => Promise<string | null>;

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
 *  navigation timeout, board redirect, kill-switch). Never throws. */
export async function renderPageHtml(url: string, timeoutMs: number = RENDER_TIMEOUT_MS): Promise<string | null> {
  if (renderDisabled()) return null;
  const deadline = Date.now() + timeoutMs;
  const remain = (): number => deadline - Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    browser = await withTimeout(getBrowser(), remain());
    if (!browser || remain() <= 0) return null;
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (JobBoard Finder)');
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
    // Let the board's JS settle. The signal is the rendered text
    // itself: poll the page's visible text until it stops changing for
    // two polls, or the cap hits. Network-idle is the wrong signal —
    // boards keep polling analytics (never idle, so the whole budget
    // burns) or go idle before their jobs request fires (so the
    // listings are missed). A page whose text never stabilises (live
    // counters, clocks) just runs to the cap and proceeds.
    const settleStart = Date.now();
    let lastLen = -1;
    let stable = 0;
    while (stable < 2 && Date.now() - settleStart < Math.min(SETTLE_CAP_MS, remain())) {
      let len = -1;
      try {
        len = await page.evaluate(() => document.body?.innerText?.length ?? 0);
      } catch {
        break;
      }
      if (len === lastLen && len >= 0) stable += 1;
      else {
        stable = 0;
        lastLen = len;
      }
      if (stable < 2 && remain() > 0) {
        await new Promise((r) => setTimeout(r, Math.min(1000, remain())));
      }
    }
    // A redirect off the business site onto a board is not a source.
    if (isBoardUrl(page.url())) return null;
    return await page.content();
  } catch {
    return null;
  } finally {
    try {
      await page?.close();
    } catch {
      // The page is already gone — nothing to clean up.
    }
  }
}
