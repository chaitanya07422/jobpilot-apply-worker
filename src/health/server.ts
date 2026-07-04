import http from 'node:http';
import Redis from 'ioredis';
import { config } from '../config';

export type HealthState = {
  workerReady: boolean;
};

async function pingRedis(): Promise<'up' | 'down'> {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    redis.disconnect();
  }
}

export function startHealthServer(state: HealthState): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = req.url?.split('?')[0] ?? '';
      if (path !== '/health' && path !== '/healthz') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
        return;
      }

      const redis = await pingRedis();
      const ok = state.workerReady && redis === 'up';
      const body = {
        ok,
        service: 'jobpilot-apply-worker',
        queue: config.queueName,
        mode: config.applyMode,
        worker: state.workerReady ? 'ready' : 'starting',
        redis,
      };

      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  });

  server.listen(config.healthPort, config.healthHost, () => {
    console.log(
      `[health] http://${config.healthHost}:${config.healthPort}/health`,
    );
  });

  return server;
}
