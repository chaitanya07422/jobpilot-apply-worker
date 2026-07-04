import { config } from './config';
import { startApplyWorker } from './queue/apply.worker';
import { connectMongo, disconnectMongo } from './status/mongo.reporter';

async function main(): Promise<void> {
  console.log('[boot] jobpilot-apply-worker starting');
  console.log(
    `[boot] redis=${config.redis.host}:${config.redis.port} queue=${config.queueName} mode=${config.applyMode}`,
  );

  await connectMongo();

  const worker = startApplyWorker();

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`);
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
