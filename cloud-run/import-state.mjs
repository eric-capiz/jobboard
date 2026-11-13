// Import a live /api/state snapshot into the LOCAL MongoDB (dealboard.app_state).
// Read-only against the live board: the snapshot is fetched separately via GET.
// Usage: node import-state.mjs [snapshot-path]
// Defaults: snapshot ~/workspace/mongodb/state-snapshot.json, mongo mongodb://127.0.0.1:27017
import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const snapPath = process.argv[2] || '/home/hatch/workspace/mongodb/state-snapshot.json';
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';

const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const state = snap.state ?? snap;
if (!state || typeof state !== 'object' || !Array.isArray(state.jobs)) {
  throw new Error('snapshot has no usable state.jobs array');
}

const client = new MongoClient(uri);
await client.connect();
const col = client.db('dealboard').collection('app_state');
const res = await col.updateOne(
  { _id: 'jobboard' },
  { $set: { state, updatedAt: snap.updatedAt ? new Date(snap.updatedAt) : new Date() } },
  { upsert: true },
);
const doc = await col.findOne({ _id: 'jobboard' });
console.log(
  'import-state: upserted=%d modified=%d jobs=%d masterResumes=%d updatedAt=%s',
  res.upsertedCount,
  res.modifiedCount,
  doc.state.jobs?.length ?? 0,
  doc.state.masterResumes?.length ?? 0,
  doc.updatedAt,
);
await client.close();
