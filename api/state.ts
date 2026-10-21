import { MongoClient } from 'mongodb';

// Minimal Vercel serverless function types (avoids @vercel/node dependency).
interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
}
interface VercelResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

let client: MongoClient | null = null;

async function getCollection() {
  if (!client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db('dealboard').collection('app_state');
}

function authorized(req: VercelRequest): boolean {
  const key = req.headers['x-sync-key'];
  const expected = process.env.SYNC_KEY;
  return !!expected && key === expected;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const col = await getCollection();

    if (req.method === 'GET') {
      const doc = await col.findOne({ _id: 'jobboard' });
      if (!doc) return res.status(404).json({ error: 'empty' });
      return res.status(200).json({ state: doc.state, updatedAt: doc.updatedAt });
    }

    if (req.method === 'PUT') {
      const { state } = req.body ?? {};
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'state required' });
      }
      await col.updateOne(
        { _id: 'jobboard' },
        { $set: { state, updatedAt: new Date() } },
        { upsert: true },
      );
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    return res.status(500).json({ error: msg });
  }
}
