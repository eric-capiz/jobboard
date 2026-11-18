// gate.js — runs the verifier over all fixtures and enforces the gate.
// Gate: ZERO false accepts on the 309 sweep fixtures + edges, AND zero false
// rejects on the hand-written expected-ACCEPT fixtures.
// Exit 0 = gate passes. Exit 1 = gate fails (CI must block on this).
// PROVENANCE (honest scoping): fixtures are labelled by evidence strength —
//   'verified'     = real posting text classified against independent ground
//                    truth (currently 0: original descriptions were not
//                    archived during the sweep);
//   'reconstructed' = description rebuilt from the checker's logged reason +
//                    neutral boilerplate (the 309 sweep fixtures);
//   'hand-written'  = synthetic cases written for the accept path and edges.
// The gate proves the verifier rejects postings matching the recorded failure
// evidence; it does NOT prove zero false accepts on unseen real postings.
// Real-posting accuracy is established by the post-push pilot audit of the
// first 100 published jobs, not by the gate alone.
'use strict';

const { verifyPosting } = require('./verifier.cjs');
// Round 9 (DeepSeek re-vote): fixtures.json is the SINGLE gate input —
// it is two-sided (309 sweep REJECTs + all hand-written ACCEPT/REJECT
// fixtures merged in by build-fixtures.cjs), so the gate is re-runnable
// from this one file. positives.cjs is the editable source of the
// hand-written side, not a second gate input — nothing is double-counted.
const all = require('./fixtures.json');
const falseAccepts = [];
const falseRejects = [];
const reasonHistogram = {};
const provenanceCount = { verified: 0, reconstructed: 0, 'hand-written': 0, unknown: 0 };

for (const f of all) {
  provenanceCount[f.provenance || 'unknown'] = (provenanceCount[f.provenance || 'unknown'] || 0) + 1;
  const result = verifyPosting(f);
  reasonHistogram[result.reason] = (reasonHistogram[result.reason] || 0) + 1;
  if (f.expected === 'REJECT' && result.verdict === 'ACCEPT') {
    falseAccepts.push({ id: f.id, company: f.company, title: f.title, source: f.source, sweepReason: f.reason || '' });
  }
  if (f.expected === 'ACCEPT' && result.verdict === 'REJECT') {
    falseRejects.push({ id: f.id, title: f.title, reason: result.reason, evidence: result.evidence });
  }
}

console.log('=== VERIFIER GATE ===');
console.log(`fixtures total: ${all.length} (sweep: ${provenanceCount.reconstructed}, hand-written: ${provenanceCount['hand-written']})`);
console.log(`provenance: verified real-posting ${provenanceCount.verified}, reconstructed ${provenanceCount.reconstructed}, hand-written ${provenanceCount['hand-written']}, unknown ${provenanceCount.unknown}`);
console.log(`expected REJECT: ${all.filter((f) => f.expected === 'REJECT').length}`);
console.log(`expected ACCEPT: ${all.filter((f) => f.expected === 'ACCEPT').length}`);
console.log(`false accepts: ${falseAccepts.length}`);
console.log(`false rejects (on expected ACCEPT): ${falseRejects.length}`);
console.log('--- reason histogram ---');
for (const [reason, count] of Object.entries(reasonHistogram).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason}: ${count}`);
}
if (falseAccepts.length) {
  console.log('--- FALSE ACCEPTS (gate failure) ---');
  for (const f of falseAccepts) console.log(`  ${f.id} | ${f.company} | ${f.title} | ${f.sweepReason}`);
}
if (falseRejects.length) {
  console.log('--- FALSE REJECTS (gate failure) ---');
  for (const f of falseRejects) console.log(`  ${f.id} | ${f.title} | ${f.reason} | ${f.evidence}`);
}
const pass = falseAccepts.length === 0 && falseRejects.length === 0;
console.log(pass
  ? `GATE: PASS — ${all.length} fixtures (${provenanceCount.verified} verified real-posting, ${provenanceCount.reconstructed} reconstructed, ${provenanceCount['hand-written']} hand-written), 0 false accepts, 0 false rejects`
  : 'GATE: FAIL');
process.exit(pass ? 0 : 1);
