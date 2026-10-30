/* Bulk import of the user's OWN company rows (backup restore, legacy
 * local payloads). Every row is deduped against the collection with the
 * same (name, domain) composite key as live discovery — importing can
 * never create a duplicate. This endpoint accepts user-supplied rows
 * only; it is not a discovery source. Max 5000 rows per call.
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY. */

import {
  addCompanies,
  authorized,
  getCompaniesCollection,
  type CompanyInput,
  type VercelRequest,
  type VercelResponse,
} from '../finder-lib.js';

const MAX_ROWS = 5000;

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
    const body = req.body ?? {};
    const rows = Array.isArray(body.companies) ? body.companies : [];
    const inputs: CompanyInput[] = rows.slice(0, MAX_ROWS).map((c: unknown) => {
      const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
      return {
        name: String(o.name ?? ''),
        website: String(o.website ?? ''),
        careersUrl: String(o.careersUrl ?? ''),
        category: String(o.category ?? ''),
        source: String(o.source ?? ''),
        addedAt: typeof o.addedAt === 'string' ? o.addedAt : undefined,
      };
    });
    const col = await getCompaniesCollection();
    const result = await addCompanies(col, inputs);
    res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
