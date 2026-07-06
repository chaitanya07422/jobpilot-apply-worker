import { Worker, type Job } from 'bullmq';
import { reportMissingFields } from '../applicant/applicant-client';
import { config, type ApplyJobPayload } from '../config';
import {
  isGreenhouseApplyUrl,
  runGreenhouseApply,
} from '../runners/greenhouse.runner';
import { runOpenUrl } from '../runners/open-url.runner';
import { updateApplyJobStatus, type ApplyStatus } from '../status/mongo.reporter';

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
    console.log('[worker] APPLY_MODE=noop — acknowledging without browser');
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

  const useGreenhouse =
    config.applyMode === 'greenhouse' &&
    isGreenhouseApplyUrl(payload.applyUrl, payload.source);

  const result = useGreenhouse
    ? await runGreenhouseApply(payload)
    : await runOpenUrl(payload);

  if (result.ok) {
    await updateApplyJobStatus({
      applyJobId: payload.applyJobId,
      status: result.status as ApplyStatus,
      lastError: '',
    });
    console.log(
      `[worker] ${result.status} ${payload.applyUrl}${useGreenhouse ? ' (greenhouse)' : ''}`,
    );
    return;
  }

  if (result.status === 'needs_input') {
    try {
      await reportMissingFields({
        applyJobId: payload.applyJobId,
        userId: payload.userId,
        jobId: payload.jobId,
        fields: result.missingFields,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[worker] failed to report missing fields: ${message}`);
    }

    await updateApplyJobStatus({
      applyJobId: payload.applyJobId,
      status: 'needs_input',
      lastError: '',
    });
    console.log(
      `[worker] needs_input (${result.missingFields.length} field(s)) ${payload.applyUrl}`,
    );
    // Do not throw: waiting on user, not a failure. BullMQ should not retry.
    return;
  }

  await updateApplyJobStatus({
    applyJobId: payload.applyJobId,
    status: 'failed',
    lastError: result.error,
  });
  console.log(`[worker] failed ${payload.applyUrl}: ${result.error}`);
  // Do not throw — avoids BullMQ auto-retry spam for permanent failures (404, etc.).
  return;
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
      `[worker] listening on queue "${config.queueName}" (mode=${config.applyMode}, submit=${config.applySubmit})`,
    );
    onReady?.();
  });

  worker.on('failed', (job, error) => {
    console.error(`[worker] failed job ${job?.id}: ${error.message}`);
  });

  worker.on('error', (error) => {
    console.error(`[worker] error: ${error.message}`);
  });

  return worker;
}
