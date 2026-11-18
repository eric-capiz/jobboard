// fetch-util.cjs — shared HTTP helpers for the ATS fetchers.
// Zero dependencies. All fetchers take an injected fetch function so tests
// use canned responses and the VM never makes live calls.
// Rules (Genspark/Claude): 3-5 rps per host, backoff on 429/403, honor
// Retry-After, per-company circuit breaker, timeouts, response-size limits.
'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB cap per response

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Minimum-interval rate limiter: at most maxRps requests per second to one
// host. Returns { wait() } — callers await wait() before each request.
function createRateLimiter(maxRps) {
  const minIntervalMs = 1000 / maxRps;
  let lastAt = 0;
  return {
    async wait() {
      const now = Date.now();
      const due = lastAt + minIntervalMs;
      if (due > now) await new Promise((r) => setTimeout(r, due - now));
      lastAt = Date.now();
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse a Retry-After header value (seconds) robustly. Garbage, NaN, or
// an HTTP-date form fall back to DEFAULT_RETRY_AFTER_MS (5s) instead of
// a zero-delay retry. Capped at 30s.
const DEFAULT_RETRY_AFTER_MS = 5000;
function parseRetryAfter(value) {
  if (value == null) return null;
  const secs = parseInt(String(value).trim(), 10);
  if (!Number.isFinite(secs) || secs < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(secs * 1000, 30000);
}

// fetchJson with retries. Retries on 429 / 403 / 5xx and network errors.
// Honors Retry-After (seconds, capped at 30s); otherwise exponential
// backoff capped at 8s. Returns { ok: true, status, json } or
// { ok: false, status, error, retryable }.
async function fetchJsonWithRetry(fetchFn, url, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limiter = opts.limiter;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (limiter) await limiter.wait();
    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetchFn(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'JobBoard-Ingest/1.0 (+https://jobboard-rt89.onrender.com)',
            ...(opts.headers || {}),
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Network error / timeout — retryable.
      if (attempt >= maxRetries) return { ok: false, status: 0, error: `network: ${err.message}`, retryable: true };
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      attempt++;
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) return { ok: false, status: res.status, error: 'response_too_large', retryable: false };
      try {
        return { ok: true, status: res.status, json: JSON.parse(text) };
      } catch {
        return { ok: false, status: res.status, error: 'invalid_json', retryable: false };
      }
    }
    const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      return { ok: false, status: res.status, error: `http_${res.status}`, retryable };
    }
    // Backoff: Retry-After wins (cap 30s), else exponential.
    const retryAfter = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('retry-after') : null;
    const delayMs = retryAfter != null
      ? parseRetryAfter(retryAfter)
      : Math.min(1000 * 2 ** attempt, 8000);
    await sleep(delayMs);
    attempt++;
  }
}

// Per-company circuit breaker. After `failureThreshold` consecutive
// failures the circuit opens for `cooldownMs`; while open, call() returns
// { ok: false, error: 'circuit_open' } WITHOUT hitting the network.
function createCircuitBreaker({ failureThreshold = 3, cooldownMs = 10 * 60 * 1000 } = {}) {
  let failures = 0;
  let openedAt = 0;
  return {
    get state() {
      if (openedAt && Date.now() - openedAt < cooldownMs) return 'open';
      if (openedAt) { openedAt = 0; failures = 0; }
      return 'closed';
    },
    get failures() { return failures; },
    async call(fn) {
      if (this.state === 'open') return { ok: false, error: 'circuit_open' };
      const result = await fn();
      if (result && result.ok === false) {
        failures++;
        if (failures >= failureThreshold) openedAt = Date.now();
      } else {
        failures = 0;
      }
      return result;
    },
  };
}

module.exports = { stripHtml, createRateLimiter, fetchJsonWithRetry, createCircuitBreaker, sleep, parseRetryAfter, DEFAULT_RETRY_AFTER_MS };
