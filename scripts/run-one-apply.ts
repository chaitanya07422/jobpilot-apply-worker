/**
 * Run a single Greenhouse apply job locally (bypasses BullMQ). Usage:
 *   npx tsx scripts/run-one-apply.ts [gh_jid]
 */
import { runGreenhouseApply } from '../src/runners/greenhouse.runner';
import { config } from '../src/config';

const ghJid = process.argv[2] ?? '6042172';
const userId = process.env.APPLY_TEST_USER_ID ?? '6a40fe1a270d18718ad0b208';
const jobId = process.env.APPLY_TEST_JOB_ID ?? '6a48ad5f444e303a2842ca1c';

async function main(): Promise<void> {
  console.log('[test] mode=%s submit=%s headless=%s', config.applyMode, config.applySubmit, config.headless);
  console.log('[test] api=%s', config.apiPublicUrl);

  const result = await runGreenhouseApply({
    applyJobId: 'local-test',
    userId,
    jobId,
    applyUrl: `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
    source: 'greenhouse',
    company: 'Stripe',
    role: 'Test',
  });

  console.log('[test] result:', JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[test] fatal:', err);
  process.exit(1);
});
