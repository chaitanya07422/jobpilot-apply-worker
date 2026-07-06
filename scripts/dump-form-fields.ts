/** Dump visible form fields on a Greenhouse embed (debug). */
import { chromium } from 'playwright';
import { fetchApplicantContext } from '../src/applicant/applicant-client';
import { config } from '../src/config';
import {
  resolveGreenhouseNavigationUrl,
} from '../src/runners/greenhouse.runner';

const ghJid = process.argv[2] ?? '6042172';
const userId = '6a40fe1a270d18718ad0b208';
const jobId = '6a48ad5f444e303a2842ca1c';

async function main(): Promise<void> {
  const url = resolveGreenhouseNavigationUrl(
    `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
  );
  const applicant = await fetchApplicantContext(userId, jobId);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

  const fields = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll('input:not([type="hidden"]), textarea, select'),
    );
    return inputs.map((el) => {
      const input = el as HTMLInputElement;
      return {
        tag: el.tagName,
        type: input.type || '',
        id: input.id || '',
        name: input.getAttribute('name') || '',
        value: input.value || '',
        visible: (el as HTMLElement).offsetParent !== null,
        classes: (el as HTMLElement).className?.slice?.(0, 60) || '',
      };
    });
  });

  console.log('applicant', applicant.firstName, applicant.lastName);
  console.log(JSON.stringify(fields.filter((f) => f.visible), null, 2));
  await browser.close();
}

main().catch(console.error);
