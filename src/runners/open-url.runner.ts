import { chromium, type Browser } from 'playwright';
import { config, type ApplyJobPayload } from '../config';

export type RunResult =
  | { ok: true; status: 'opened' }
  | { ok: false; status: 'failed'; error: string };

/**
 * Phase A: open applyUrl, wait for load, do not fill forms.
 */
export async function runOpenUrl(payload: ApplyJobPayload): Promise<RunResult> {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);

    const response = await page.goto(payload.applyUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs,
    });

    const status = response?.status() ?? 0;
    if (status >= 400) {
      return {
        ok: false,
        status: 'failed',
        error: `Page returned HTTP ${status}`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    return { ok: true, status: 'opened' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 'failed', error: message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
