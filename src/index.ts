import { config } from './config';
import { startHealthServer, type HealthState } from './health/server';
import { startApplyWorker } from './queue/apply.worker';
import { connectMongo, disconnectMongo } from './status/mongo.reporter';

async function main(): Promise<void> {
  console.log('[boot] jobpilot-apply-worker starting');
  console.log(
    `[boot] redis=${config.redis.host}:${config.redis.port} queue=${config.queueName} mode=${config.applyMode}`,
  );

  // Mongo is optional in Phase 1; TLS/Atlas issues must not crash the worker.
  await connectMongo();

  const healthState: HealthState = { workerReady: false };
  const healthServer = startHealthServer(healthState);
  const worker = startApplyWorker(() => {
    healthState.workerReady = true;
  });

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`);
    healthState.workerReady = false;
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await worker.close();
    await disconnectMongo();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[boot] fatal: ${message}`);
  process.exit(1);
});
