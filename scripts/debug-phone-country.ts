/** Dump phone country select options when searching "India". */
import { chromium } from 'playwright';
import { resolveGreenhouseNavigationUrl } from '../src/runners/greenhouse.runner';

const ghJid = process.argv[2] ?? '6042172';

async function main(): Promise<void> {
  const url = resolveGreenhouseNavigationUrl(
    `https://stripe.com/jobs/search?gh_jid=${ghJid}`,
  );
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.locator('#country').waitFor({ state: 'visible' });

  const countryInput = page.locator('#country');
  await countryInput.click();
  await countryInput.fill('');
  await countryInput.pressSequentially('India', { delay: 30 });
  await page.waitForTimeout(500);

  const options = await page.locator('.select__option, [role="option"]').allInnerTexts();
  console.log('options after typing India:', options.slice(0, 15));

  const phoneSection = await page.locator('text=Phone').first().locator('xpath=ancestor::div[contains(@class,"field") or contains(@class,"question")][1]').innerHTML().catch(() => 'n/a');
  console.log('phone section html snippet:', phoneSection.slice(0, 1500));

  const dialCode = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.textContent?.match(/^\+\d{1,4}$/))
      .map((el) => el.textContent?.trim());
    return labels.slice(0, 10);
  });
  console.log('dial codes on page:', dialCode);

  await browser.close();
}

main().catch(console.error);
