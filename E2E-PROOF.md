# End-to-end proof — rebuild ingest pipeline (2026-11-17, run by parent, not the coordinator)

Script: /tmp/e2e-proof.cjs (canned ATS payloads only, zero live network calls).
Fresh temp DB, 4 companies: Acme (Greenhouse), Globex (Lever), Initech (Ashby) — all US-verified — plus Sneaky (Canada, not US-verified, must be skipped with zero fetches).

## Result: PASS

```
INGEST TOTALS {"fetched":9,"accepted":3,"rejected":6,"closed":0,"skipped":1,"partialRuns":0,"errors":0}
DB COUNTS {"companies":3,"live":3,"rejected":6,"verifications":3}
PUBLIC BOARD (listLiveJobs):
  LIVE: acme.com | Customer Success Manager | Remote - United States
  LIVE: globex.com | Frontend Engineer | Remote - United States
  LIVE: initech.com | Customer Support Specialist | Remote - United States
REJECT LOG:
  REJECT: hybrid | hybrid role: 2 days per week in our austin office...
  REJECT: state_restricted | not available in california or new york...
  REJECT: blank_location | (no location given)
  REJECT: based_in_place | fully remote position based in canada.
  REJECT: ats_workplace_not_remote | ATS workplaceType=Hybrid
  REJECT: travel_required | up to 25% travel required to client sites...
```

What this proves: a real job flows ATS payload → fetcher → verifier → DB → public query, and every bad pattern from the 309-job sweep (hybrid, state-restricted, blank location, non-US, Hybrid flag, travel) is rejected with its reason + evidence span. A non-US-verified company is never even fetched. The public query returns ONLY the 3 genuine remote-US jobs.
