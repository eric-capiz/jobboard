/* One-time migration: move any companies still stored in the app state
 * doc into the 'companies' collection, then clear them from the state
 * doc. Idempotent — a second call is a no-op. Rows that cannot be
 * converted (no name) are left in the state doc, never silently lost.
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY. */

import {
  authorized,
  getCompaniesCollection,
  getDb,
  migrateStateCompanies,
  type AppStateDoc,
  type VercelRequest,
  type VercelResponse,
} from '../finder-lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const db = await getDb();
    const col = await getCompaniesCollection();
    const appStateCol = db.collection<AppStateDoc>('app_state');
    const result = await migrateStateCompanies(col, appStateCol);
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
