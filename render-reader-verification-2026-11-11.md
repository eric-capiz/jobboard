# Browser-based reader for JobBoard Find Jobs — verification record
Date: 2026-11-11 (all times MST). Authorized by Eric 13:29 MST ("Make the app see it all.. I dont care how its done, just do it").

## (a) Design decision — where the browser runs

Inside the find-jobs serverless function itself, via `@sparticuz/chromium-min` 153.0.0 + `puppeteer-core` 25.17.0.
- The npm package is a 46KB loader; the Chromium binary is NOT in the deployment (far under Vercel's 250MB function limit). First render on a warm instance downloads the pinned pack (~70MB) from the @sparticuz/chromium GitHub releases into /tmp and extracts it there; later renders reuse it.
- $0: MIT packages, free public release download.
- Vercel Hobby limits found: maxDuration cap 60s (set `export const config = { maxDuration: 60 }` on api/find-jobs.ts and api/test-company.ts), memory 1024MB, /tmp 512MB (70MB pack fits).
- Node ≥22 required (chromium-min engines ^22.17.0) — package.json gained `"engines": { "node": "22.x" }`.
- Fallback order: plain HTML first (unchanged); only when a page loads but yields zero postings, render the SAME careers-page URL — only careers-like URLs (the careersUrl itself, or a path containing career/job), at most 1 render per company in Test a company, max 2 per Find Jobs chunk, only in the first 30s of a chunk. A page that only links out to a board still returns nothing; a redirect onto a board domain returns null.
- Wait strategy (after live evidence): DOM-stable wait — poll visible text until it stops changing for 2 polls, cap 12s; network-idle proved the wrong signal (boards poll analytics forever, or go idle before their jobs request fires). Kill-switch: JOBBOARD_NO_RENDER=1.

## (b) Pushes (one per batch, all via GitHub snapshot flow, read back byte-for-byte)

1. `0182d6c9604629a7f1e0011cc3292ac95eda4c96` — "Find Jobs: render JS careers pages in Chromium (browser fallback)" — 7 files: api/render-page.ts (new), api/find-jobs.ts, api/test-company.ts, api/finder-lib.ts, package.json, package-lock.json, tests/finder.test.mjs.
2. `36918be8faa499b4f9b6fbc2a3241506629cd3f1` — "Find Jobs: render waits for listings to settle (DOM-stable wait) + surface renderMs" — api/render-page.ts, api/test-company.ts.
3. `24a2c735e7566f748677c920db2a39c1fc705d82` — "Find Jobs: surface what the render saw (renderTextSample) for zero-listing diagnosis" — api/find-jobs.ts, api/test-company.ts, tests/finder.test.mjs. Sync record now 26 entries.
4. `8c016280f4cec73f73ef890883bf9c2a3b15e7b3` — "Find Jobs: submit the portal's own job search in the render reader" — api/render-search.ts (new), api/render-page.ts, api/find-jobs.ts, tests/finder.test.mjs. Sync record now 27 entries.
5. `d5874bb0441103f5ade03be35241355aae61b50b` — "Find Jobs: make the portal search observable + render the best candidate (zero-count fix, deferred render)" — api/render-search.ts, api/render-page.ts, api/find-jobs.ts, api/test-company.ts, tests/finder.test.mjs. Sync record now 28 entries.
6. `0c7fedb49b605df13305f7f75309792468f06401` — "Find Jobs: extract job-card anchors (Concentrix JDQ cards) that Strategy A shatters" — api/find-jobs.ts, tests/finder.test.mjs. Sync record now 29 entries.

Verification before each push: `npx tsc --noEmit` clean, `npm run build` clean, test suite 170 passed / 0 failed (168 at push 1, +2 renderTextSample checks at push 3) → 199 at push 4 → 213 at push 5 → **217 at push 6**.

## (c) Live verification — canaries (live POST /api/test-company, demo-customer-service resume)

| Company | Result | Source discipline |
|---|---|---|
| Day Kimball (regression) | **70** Multispecialty Patient Service Representative, 60+60 Patient Service Rep, postingsSeen 50, sourcePage = Paycor CareerHome URL | triedUrls = own site only; render ran once (9–16s) on an intermediate careers page and found nothing — speculative-render cost, see below |
| Humana (render) | **2 postings via render** (renderUsed True, sourcePage careers.humana.com), 0 leads (both rejected on resume match). FLAKY: 2 listings in runs 1, 2, 4; 0 in run 3 — their jobs endpoint is intermittent | triedUrls = ONLY careers.humana.com; no board-domain fetches |
| Walmart (homepage + /results) | 0 postings, render ran (10–17s) | renderTextSample (push 3): empty shell — nav + "Sorry, we have no imagery here" / map keystroke text, no jobs, no challenge text. Bare /results shows no jobs — search-gated |
| FedEx | 0 postings, render ran | static shell has no challenge markers |
| Thermo Fisher | 0 postings, render ran (~26s under old idle wait) | — |
| CVS | 0 postings, render ran; 1 posting from www.cvshealth.com homepage HTML (rejected on match) | — |
| Hilton | 0 postings, render ran (4.8s) | — |
| Southwest | 0 postings via render; 1 posting from a terms page (rejected on match) | — |
| Centene / Molina / Elevance / Accenture | HTML already yields listings (2/3/10/5) — render never fires; not render canaries | — |

**Verdict vs the bar:** 1 of 2–3 render canaries returns real listings (Humana), and it is flaky (2 of 3 runs). The render mechanism works end to end; the remaining pages are search portals that display NO jobs on passive load — proven by renderTextSample, not inferred. No bot-challenge wording appeared in any rendered sample, so bot-gating is not the observed cause.

## (d) Search interaction — design (pushes 4–6)

New module `api/render-search.ts`, descriptor-based so the offline suite drives it with a fake page (no browser):
- After the render settles, scan the DOM for a visible job-search box (scored by name/id/placeholder/aria-label; location boxes score negative) + submit button (same-form search/find text → same-form submit → page-level "search jobs|find jobs" → bare "Search"; nearest-by-viewport-top wins when a page has two boxes). If the page already shows listings, do nothing.
- Submit an empty search first (all jobs); if that shows nothing and a resume term was supplied, submit again with the resume's two most frequent terms (`portalSearchTerm`: demo-CS → `"service customer"`). Submission uses **real keystrokes + Enter** (plus a real mouse click on the submit button as fallback) — React portals ignore script-set values and synthetic `.click()` (proven on Walmart). Wait for navigation or a text change, then a short DOM-stable settle, bounded by the render deadline. Every failure returns an outcome, never a throw: `has-listings | searched | no-form | submit-failed | no-results | board-redirect | skipped-time`.
- **Observability (push 5):** `RenderPageFn` now returns `{ html, searchOutcome, searchMs, renderedUrl }`; the fields ride through `CompanySearchResult` into the `/api/test-company` response, so a zero-listing render can finally be told apart from a render that never searched. A board redirect returns an empty-HTML result (not null) so the outcome still surfaces.
- **Deferred rendering (push 5):** the plain-HTML walk finishes FIRST; the single per-company render then goes to the best-scoring zero-yield candidate (`renderTargetScore`: search/results URL +5, /search +4, /jobs or /careers +2, the user-given careers link +2; ties break to earliest in walk order). Rendering the first zero-yielding candidate mid-walk spent the budget on FAQ/culture pages before the portal link on that same page was ever discovered.
- **Limits/failure modes:** search needs ≥6s of render budget left or it is skipped (`skipped-time`); max 20s/render, 2 renders/chunk; a form whose action is a board URL refuses the submit; a submit that navigates onto a board returns nothing. Source discipline unchanged: the search runs only on the company's own careers page; `triedUrls`/`sourcePage` still prove it.

### Bugs found by live canaries + local probing (all fixed, all in the suite)
1. **False-positive "page already has listings" (Walmart):** a homepage's 25 trending-role/career-area links satisfied the old link counter → search skipped. Fix: listings require a results-count line backed by ≥1 job link.
2. **Synthetic submit dead on React portals (Walmart):** script-set value + `el.click()` silently did nothing twice; real keystrokes + Enter navigated to `/us/en/results?searchQuery=...`. Fix: `submitViaEnter` + real-mouse-click fallback.
3. **Missed submit button (Walmart):** the visible Search button has only `aria-label="Search"` (no text). Fix: bare `/\bsearch\b/i` button tier.
4. **"0 jobs" counts as a results line (Concentrix, push 5):** the shell says "Search results (0 jobs available)" and carries "Search & Apply" nav links → `hasVisibleListings` true → the search never ran. Fix: a results count only counts when parsed > 0.
5. **Extractor shatters job-card anchors (Concentrix, push 6 — the real portal-direct blocker):** the shell is NOT empty post-render — the page embeds 1,900 jobs as JSON and the JDQ widget renders 10 cards/page, so `has-listings` was CORRECT and the search rightly skipped. But `parseCareersPage` Strategy A splits on every element whose class mentions "job" (card, title, description, meta), fragmenting each card into a link-less title chunk and a title-less link chunk — both skipped, 0 postings. Fix: Strategy C matches the whole `<a class="...job-card...">` anchor at once (href = apply link, first inner heading = title). Verified locally against 10 real JDQ cards built from the embedded data: 10/10 extracted; suite 217/0.

## (e) Live verification — round 2 (pushes 5–6, 2026-11-11 ~15:51–16:20 MST, demo-customer-service resume)

| Company | Result | What the outcome field proved |
|---|---|---|
| **Concentrix portal-direct** (`careersUrl=https://jobs.concentrix.com/job-search/`) | **10 postings, 2 leads at 60** (Director, IT Service Delivery Management (TCF); Customer Support Advisor - Evenings), both review/blank-location, `sourceType=rendered`, `renderUsed=True`, `renderMs=14,486` | `searchOutcome=has-listings` (correct — the widget renders 1,900 jobs; the search rightly skipped). Pre-push-6 the same canary returned 0: Strategy A shattered the JDQ cards. Post-push-6: 10/10 page-1 cards extracted |
| **Concentrix normal flow** (`careersUrl=/united-states/`) | **0 postings, fetchOk False on all 4 URLs in 0.74s** — no render ran | Site-side block, not code: `careers.concentrix.com` terminates connections with no response from BOTH the VM and Vercel (curl 52; TCP connects, TLS ok, then close). The walk fetches nothing, so no nav link to /job-search/ is ever discovered and no render target exists. Deferred rendering cannot fix an unfetchable site — the roster URL needs to point at `jobs.concentrix.com/job-search/` instead (data fix, not code) |
| **CVS** (`jobs.cvshealth.com/`) | **14 postings, 2 leads at 65** (Senior Customer Service Representative, Remote; Bilingual Customer Service Representative – Broker Services, Remote), both review, `renderUsed=True` | `searchOutcome=searched`, `searchMs=8,307`, `renderedUrl=https://jobs.cvshealth.com/us/en/search-results?keywords=service%20customer` — the resume-term search populated the Phenom results; pre-push-6 this was `no-results` (extractor missed the Phenom cards, same fragmentation as JDQ) |
| **Walmart** (`careers.walmart.com/`) | **0 postings — the one remaining fail.** `searchOutcome=no-results`, `searchMs=5,344`, `renderedUrl=https://careers.walmart.com/us/en/results` | The search WORKS (real keystrokes navigate to the results page) but the results list never populates in the rendered DOM: local probe dump of the post-search page (125KB) shows the "Open roles" tab selected with zero job cards, and the real extractor finds 0. The results XHR either needs longer than the 4s post-submit settle or never fires in the render. Follow-up, not in this batch: longer results wait / wait for the results request |
| **FedEx** (`careers.fedex.com/jobs`) | **25 postings via plain HTML** (was 1 in round 1), 0 leads — all 25 rejected on resume match (mostly driver/warehouse roles) | No render needed; "returns listings" bar met — 0 leads is a match outcome, not a reader failure |
| **Day Kimball (regression)** | **70** Multispecialty Patient Service Representative, 9 leads, postingsSeen 50 — unchanged across pushes 5 and 6 | `searchOutcome=null` (no render ran — plain HTML found the Paycor listings first, as designed) |
| **TTEC diagnosis** | `www.ttec.com` **fetchOk False on all 3 URLs** from Vercel in <1s — NOT DNS/TLS/timeout (VM: DNS instant, TLS 0.27s). VM UA test: Chrome UA → 403, default curl UA → 200, JobBoard UA → 403 — a **WAF bot rule on www.ttec.com rejecting Mozilla-style UAs**. `www.ttecjobs.com/en` loads fine from Vercel: **12 postings seen** (all 12 rejected on match — they are nav-link "postings", the same 12 Track A saw), 0 leads. Roster fix: point TTEC at ttecjobs.com, not www.ttec.com | — |

**Round-2 verdict vs the bar:** Concentrix portal-direct ✓, CVS ✓, FedEx ✓ (listings), Day Kimball 70 ✓. Concentrix normal flow ✗ (site unreachable — data fix). Walmart ✗ (search runs, results don't populate — needs a follow-up). 4 of 6 canary bars met; the two misses are diagnosed with a named next step each, not silent zeroes.

## Throughput numbers (for the volume plan)

- Cold render ~23s (incl. ~70MB download); warm renders 5–17s (settle cap 12s + nav).
- Render fires speculatively on the first zero-yielding careers-like page, often an intermediate page (Day Kimball burned 9–16s on a careers page before the Paycor HTML won). A per-company render is not free even when HTML later wins.
- 33,948 of 40,188 companies yield zero postings (84.6%) — the render only cracks the subset whose pages display jobs on load. Search portals need a search submitted.

## Open items / decisions for Eric (via parent)

1. **Search interaction** — DONE (pushes 4–6, see (d) above): the render reader now submits the portal's own search (empty first, then the resume term, real keystrokes + Enter), with the outcome surfaced as `searchOutcome`/`searchMs`/`renderedUrl`. Walmart is the one portal where the search runs but results still don't populate (see (e)).
2. **Deferred rendering** — DONE (push 5): the HTML walk finishes first, then the single per-company render goes to the best-scoring zero-yield candidate (search/results URL preferred).
3. **Settle tuning** — Humana's intermittent jobs endpoint suggests more settle time (or a retry) would raise render yield; the room is bounded by the 60s function cap and the 20s per-render timeout. Now also the prime suspect for Walmart: the results XHR may need longer than the 4s post-submit settle.
4. **Board state after all canary work:** 0 jobs, 5 master resumes intact (demo-customer-service, demo-frontend, customer service, Frontend, liar-frontend). No board writes from this work; test-company is read-only by design.
5. **No full sweep launched** — a render sweep needs the time/volume plan first.
6. **Roster URL fixes (data, not code):** Concentrix's roster careers URL should be `https://jobs.concentrix.com/job-search/` (the `careers.concentrix.com` host refuses all connections from Vercel); TTEC's should be `https://www.ttecjobs.com/en` (`www.ttec.com` WAF-blocks browser UAs).
7. **Pagination (Concentrix):** the widget renders 10 cards/page of 1,900 jobs; the reader only ever sees page 1. A page-2+ walk would multiply yield but is a separate step — and only 182 of the 1,900 are fully-remote, most roles non-US.
