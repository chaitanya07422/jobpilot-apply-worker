/**
 * Fill + submit and dump post-submit page state.
 * Usage: DEBUG_SUBMIT=1 npx tsx scripts/debug-after-submit.ts [gh_jid]
 */
import { chromium } from 'playwright';
import {
  downloadResumeToTempFile,
  fetchApplicantContext,
  removeTempFile,
} from '../src/applicant/applicant-client';
import { config } from '../src/config';
import { resolveGreenhouseNavigationUrl } from '../src/runners/greenhouse.runner';

const ghJid = process.argv[2] ?? '6042172';
const userId = process.env.APPLY_TEST_USER_ID ?? '6a40fe1a270d18718ad0b208';
const jobId = process.env.APPLY_TEST_JOB_ID ?? '6a48ad5f444e303a2842ca1c';

async function dump(label: string, getText: () => Promise<string>, extra: Record<string, unknown>): Promise<void> {
  const text = (await getText()).replace(/\s+/g, ' ').slice(0, 1200);
  console.log(`\n--- ${label} ---`);
  for (const [k, v] of Object.entries(extra)) console.log(`${k}:`, v);
  console.log('text:', text);
}

async function main(): Promise<void> {
  const applicant = await fetchApplicantContext(userId, jobId);
  const resumePath = await downloadResumeToTempFile(userId, applicant.resumeFileName);
  const navigationUrl = resolveGreenhouseNavigationUrl(
    `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(navigationUrl, { waitUntil: 'load', timeout: 60_000 });

  const formRoot = page;
  await formRoot.locator('#first_name, #email').first().waitFor({ state: 'attached', timeout: 60_000 });

  // Dynamic import to access module internals via re-running - use eval hack
  // Instead duplicate fill by importing runner's exported function with a hook
  
  // Patch: use runGreenhouseApply but intercept - can't. Fill manually via page.evaluate injection.
  
  // Import runner module and call runGreenhouseApply on SAME browser - not possible.
  // Call internal fill via exposing it temporarily.

  const runnerPath = '../src/runners/greenhouse.runner';
  const { runGreenhouseApply } = await import(runnerPath);

  await browser.close();
  await removeTempFile(resumePath);

  // Run full apply - we'll add dump inside runner via env
  process.env.DEBUG_SUBMIT_DUMP = '1';
  const result = await runGreenhouseApply({
    applyJobId: 'debug',
    userId,
    jobId,
    applyUrl: `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
    source: 'greenhouse',
  });
  console.log('\nresult:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
