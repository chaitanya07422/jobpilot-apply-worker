/** Fill form and dump phone country + location state before submit. */
import { chromium } from 'playwright';
import {
  downloadResumeToTempFile,
  fetchApplicantContext,
  removeTempFile,
} from '../src/applicant/applicant-client';
import { config } from '../src/config';
import { resolveGreenhouseNavigationUrl } from '../src/runners/greenhouse.runner';

const ghJid = process.argv[2] ?? '6042172';
const userId = '6a40fe1a270d18718ad0b208';
const jobId = '6a48ad5f444e303a2842ca1c';

async function dumpField(page: import('playwright').Page, id: string): Promise<void> {
  const inputVal = await page.locator(`#${id}`).inputValue().catch(() => '');
  const singleVal = await page
    .locator(`#${id}`)
    .locator('xpath=preceding-sibling::div[contains(@class,"select__control")][1] .select__single-value')
    .innerText()
    .catch(() => '');
  const ariaInvalid = await page.locator(`#${id}`).getAttribute('aria-invalid').catch(() => '');
  const error = await page.locator(`#${id}-error, [id="${id}-error"]`).innerText().catch(() => '');
  console.log(`[${id}] input="${inputVal}" single="${singleVal}" invalid=${ariaInvalid} error="${error}"`);
}

async function main(): Promise<void> {
  const applicant = await fetchApplicantContext(userId, jobId);
  const resumePath = await downloadResumeToTempFile(userId, applicant.resumeFileName);
  const url = resolveGreenhouseNavigationUrl(`https://stripe.com/jobs/search?gh_jid=${ghJid}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.locator('#first_name').waitFor({ state: 'visible' });

  // Run apply without submit by temporarily patching - use env
  await browser.close();
  await removeTempFile(resumePath);

  process.env.APPLY_SUBMIT = 'false';
  const { runGreenhouseApply } = await import('../src/runners/greenhouse.runner');
  await runGreenhouseApply({
    applyJobId: 'debug',
    userId,
    jobId,
    applyUrl: `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
    source: 'greenhouse',
  });

  // Re-open and fill manually to inspect - use second browser after apply closes
  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage();
  await page2.goto(url, { waitUntil: 'load' });
  await page2.locator('#country').waitFor({ state: 'visible' });

  const loc = applicant.answers.candidate_location;
  console.log('target location:', loc, 'phoneCountry:', applicant.phoneCountry);

  // Manual fill country
  const countryInput = page2.locator('#country');
  await countryInput.click();
  await countryInput.fill('');
  await countryInput.pressSequentially('India', { delay: 25 });
  await page2.waitForTimeout(500);
  const opts = await page2.locator('.select__option').allInnerTexts();
  console.log('country options:', opts.filter(o => /india/i.test(o)));
  const indiaOpt = page2.locator('.select__option').filter({ hasText: /^India \+91/i }).first();
  await indiaOpt.click();
  await page2.waitForTimeout(300);
  await dumpField(page2, 'country');

  // Manual fill location
  const locInput = page2.locator('#candidate-location');
  await locInput.click();
  await locInput.fill('');
  await locInput.pressSequentially(String(loc), { delay: 25 });
  await page2.waitForTimeout(800);
  const locOpts = await page2.locator('.select__option').allInnerTexts();
  console.log('location options (first 8):', locOpts.slice(0, 8));
  if (locOpts.length > 0) {
    await page2.locator('.select__option').first().click();
  }
  await page2.waitForTimeout(300);
  await dumpField(page2, 'candidate-location');

  await browser2.close();
}

main().catch(console.error);
