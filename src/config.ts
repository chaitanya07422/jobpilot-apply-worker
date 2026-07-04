import { config as loadEnv } from 'dotenv';

loadEnv();

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export const config = {
  redis: {
    host: required('REDIS_HOST', '127.0.0.1'),
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD?.trim() || undefined,
  },
  mongoUri: process.env.MONGODB_URI?.trim() || '',
  queueName: required('APPLY_QUEUE_NAME', 'apply'),
  /** noop = acknowledge jobs only; open = Playwright navigate (Phase A) */
  applyMode: (process.env.APPLY_MODE?.trim() || 'noop') as 'noop' | 'open',
  headless: bool('PLAYWRIGHT_HEADLESS', true),
  concurrency: Math.max(1, Number(process.env.CONCURRENCY ?? 1)),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 60_000),
  healthHost: process.env.HEALTH_HOST?.trim() || '0.0.0.0',
  healthPort: Number(process.env.HEALTH_PORT ?? 3100),
};

export type ApplyJobPayload = {
  applyJobId: string;
  userId: string;
  jobId: string;
  applyUrl: string;
  source?: string;
  company?: string;
  role?: string;
};
