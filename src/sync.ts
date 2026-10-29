/* Cloud sync — mirrors app state to MongoDB via /api/state.
   Single-user: last-write-wins. localStorage stays the offline fallback.
   No-ops gracefully when VITE_SYNC_KEY is not set (e.g. local dev). */

const SYNC_KEY = (import.meta as any).env?.VITE_SYNC_KEY as string | undefined;
const API_URL = '/api/state';

export function isSyncEnabled(): boolean {
  return !!SYNC_KEY;
}

/** The sync key for authenticated API calls (Finder job search).
 *  Already embedded in the client bundle via VITE_SYNC_KEY — same key the
 *  app uses for state sync, no new secret. */
export function getSyncKey(): string | undefined {
  return SYNC_KEY;
}

export interface CloudState {
  state: unknown;
  updatedAt: string;
}

export async function fetchCloudState(): Promise<CloudState | null> {
  if (!SYNC_KEY) return null;
  try {
    const r = await fetch(API_URL, { headers: { 'x-sync-key': SYNC_KEY } });
    if (!r.ok) return null;
    return (await r.json()) as CloudState;
  } catch {
    return null; // offline — localStorage is the fallback
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function pushCloudStateDebounced(payload: unknown): void {
  if (!SYNC_KEY) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await fetch(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-sync-key': SYNC_KEY },
        body: JSON.stringify({ state: payload }),
      });
    } catch {
      // offline — localStorage keeps the data, sync resumes next change
    }
  }, 2000);
}
