import { Worker, type Job } from 'bullmq';
import { config, type ApplyJobPayload } from '../config';
import { runOpenUrl } from '../runners/open-url.runner';
import { updateApplyJobStatus } from '../status/mongo.reporter';

function isApplyPayload(data: unknown): data is ApplyJobPayload {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const d = data as Record<string, unknown>;
  return (
    typeof d.applyJobId === 'string' &&
    typeof d.userId === 'string' &&
    typeof d.jobId === 'string' &&
    typeof d.applyUrl === 'string'
  );
}

async function processApplyJob(job: Job): Promise<void> {
  const payload = job.data;

  if (!isApplyPayload(payload)) {
    console.warn('[worker] invalid payload, skipping', job.id, job.data);
    return;
  }

  console.log(
    `[worker] job ${job.id} applyJobId=${payload.applyJobId} mode=${config.applyMode} url=${payload.applyUrl}`,
  );

  if (config.applyMode === 'noop') {
    console.log(
      '[worker] APPLY_MODE=noop — acknowledging without browser',
    );
    await updateApplyJobStatus({
      applyJobId: payload.applyJobId,
      status: 'opened',
      lastError: '',
    });
    return;
  }

  await updateApplyJobStatus({
    applyJobId: payload.applyJobId,
    status: 'running',
  });

  const result = await runOpenUrl(payload);

  if (result.ok) {
    await updateApplyJobStatus({
      applyJobId: payload.applyJobId,
      status: 'opened',
      lastError: '',
    });
    console.log(`[worker] opened ${payload.applyUrl}`);
    return;
  }

  await updateApplyJobStatus({
    applyJobId: payload.applyJobId,
    status: 'failed',
    lastError: result.error,
  });
  throw new Error(result.error);
}

export function startApplyWorker(onReady?: () => void): Worker {
  const worker = new Worker(config.queueName, processApplyJob, {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
    },
    concurrency: config.concurrency,
  });

  worker.on('ready', () => {
    console.log(
      `[worker] listening on queue "${config.queueName}" (concurrency=${config.concurrency})`,
    );
    onReady?.();
  });

  worker.on('failed', (job, error) => {
    console.error(
      `[worker] failed job ${job?.id}: ${error.message}`,
    );
  });

  worker.on('error', (error) => {
    console.error(`[worker] error: ${error.message}`);
  });

  return worker;
}
