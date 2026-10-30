/* Companies list API — server-paged reads from the 'companies'
 * collection (the Finder's database). The client table + search page
 * through this endpoint; the full list never rides in the state doc.
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY. */

import {
  authorized,
  firstQuery,
  getCompaniesCollection,
  listCompanies,
  type VercelRequest,
  type VercelResponse,
} from './finder-lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const col = await getCompaniesCollection();
    const skipRaw = Number(firstQuery(req, 'skip') ?? 0);
    const limitRaw = Number(firstQuery(req, 'limit') ?? 25);
    const result = await listCompanies(col, {
      skip: Number.isFinite(skipRaw) ? skipRaw : 0,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
      q: firstQuery(req, 'q') ?? '',
    });
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
