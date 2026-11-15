// One-off fix: the 43 big employers imported 2026-11-14 were stored with
// source='Manual', which the matcher treats as "country unknown" — so their
// blank / bare-'Remote' locations verdict 'review' (needsReview) and can
// never auto-add, no matter how high they score. These are known U.S.
// employers; re-label them 'Import' so the location verdict treats them
// as U.S. companies (blank / bare-'Remote' passes, same as the roster).
// Run once via .github/workflows/fix-import-source.yml (workflow_dispatch).
// Safe to re-run: only touches rows still labeled 'Manual' in the list.
import { MongoClient } from 'mongodb';

const NAMES = ["Foundever", "Teleperformance", "Alorica", "Chewy", "DoorDash", "Beyond Finance", "Kobie", "Remember The Milk", "Alight Solutions", "Appen", "Arise", "AssetWatch", "Bonfire", "Continuum Global Solutions", "Discount Dental", "Discover (Financial)", "GetInsured (Vimo)", "Hello Heart", "InVision (now Instabug)", "Jobber", "Midi Health", "NICE Satmetrix", "NexRep", "Omni Interactions", "OneTouch Direct", "REVOLVE", "RxRoute / DirectMeds", "Sage (K12)", "Sagility", "ShyftOff", "Sutherland", "The Difference Card", "UnitedHealthcare", "VXI Global Solutions", "Working Solutions", "ResultsCX", "Everise", "TELUS Digital", "Transcom", "IBEX (ibex)", "Qualfon", "Startek", "ModSquad"];

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI not set');

const client = new MongoClient(uri);
await client.connect();
const col = client.db('dealboard').collection('companies');
const res = await col.updateMany(
  { name: { $in: NAMES }, source: 'Manual' },
  { $set: { source: 'Import' } },
);
console.log(`matched=${res.matchedCount} modified=${res.modifiedCount} (expected 43/43 on first run)`);
// Verify none of the 43 are still 'Manual'.
const remaining = await col.countDocuments({ name: { $in: NAMES }, source: 'Manual' });
console.log(`still Manual: ${remaining}`);
await client.close();
if (remaining !== 0) throw new Error(`expected 0 remaining Manual, got ${remaining}`);
console.log('OK');
