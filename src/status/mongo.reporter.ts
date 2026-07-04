import { MongoClient, ObjectId, type Db } from 'mongodb';
import { config } from '../config';

export type ApplyStatus =
  | 'queued'
  | 'running'
  | 'opened'
  | 'applied'
  | 'failed'
  | 'cancelled';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<boolean> {
  if (!config.mongoUri) {
    console.warn(
      '[mongo] MONGODB_URI not set — status updates disabled (Phase 1 idle mode)',
    );
    return false;
  }

  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db();
  console.log('[mongo] connected');
  return true;
}

export async function disconnectMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function updateApplyJobStatus(params: {
  applyJobId: string;
  status: ApplyStatus;
  lastError?: string;
}): Promise<void> {
  if (!db) {
    return;
  }

  let _id: ObjectId;
  try {
    _id = new ObjectId(params.applyJobId);
  } catch {
    console.warn(`[mongo] invalid applyJobId: ${params.applyJobId}`);
    return;
  }

  const now = new Date();
  const $set: Record<string, unknown> = {
    status: params.status,
    updatedAt: now,
  };

  if (params.status === 'running') {
    $set.startedAt = now;
  }
  if (
    params.status === 'opened' ||
    params.status === 'applied' ||
    params.status === 'failed'
  ) {
    $set.finishedAt = now;
  }
  if (params.lastError !== undefined) {
    $set.lastError = params.lastError;
  }

  const update: Record<string, unknown> = { $set };
  if (params.status === 'failed') {
    update.$inc = { attempts: 1 };
  }

  await db.collection('apply_jobs').updateOne({ _id }, update);
}
