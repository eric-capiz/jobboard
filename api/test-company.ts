/* Single-company job test — no database involved.
 *
 * POST { company: { name, website, careersUrl }, resumeText } and the
 * endpoint runs exactly the same search the full Find Jobs sweep runs
 * for one company, business site ONLY: listings parsed straight off
 * the company's own careers page, or the job-list widget embedded in
 * that page. No board is ever fetched as a source — the only board
 * contact allowed is the apply link on a listing found on the business
 * page. Nothing is written: the company is NOT added to the database
 * and no lead touches the Pipeline — the caller decides what to do
 * with the result. That makes it a true test: if you know a company
 * is hiring for your resume's skill set, this tells you whether its
 * careers page is detected and the job found.
 *
 * Auth mirrors /api/state: x-sync-key must match SYNC_KEY.
 */

import { authorized, type VercelRequest, type VercelResponse } from './finder-lib.js';
import { searchCompanyJobs } from './find-jobs.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = req.body ?? {};
    const c = (
      typeof body.company === 'object' && body.company !== null ? body.company : {}
    ) as Record<string, unknown>;
    const name = String(c.name ?? '').trim();
    const website = String(c.website ?? '').trim();
    const careersUrl = String(c.careersUrl ?? '').trim();
    const resumeText = typeof body.resumeText === 'string' ? body.resumeText : '';
    if (!name || (!website && !careersUrl)) {
      res
        .status(400)
        .json({ error: 'A company name and a website or careers link are required.' });
      return;
    }
    const result = await searchCompanyJobs({ name, website, careersUrl }, resumeText);
    res.status(200).json({
      company: name,
      sourcePage: result.sourcePage,
      triedUrls: result.triedUrls,
      postingsSeen: result.postingsSeen,
      fetchOk: result.fetchOk,
      screened: result.screened,
      leads: result.leads,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    res.status(500).json({ error: msg });
  }
}
