import { chromium, type Browser, type FrameLocator, type Locator, type Page } from 'playwright';
import {
  downloadResumeToTempFile,
  fetchApplicantContext,
  removeTempFile,
  type ApplicantContext,
} from '../applicant/applicant-client';
import { config, type ApplyJobPayload } from '../config';

export type ReportedField = {
  key: string;
  label: string;
  type: string;
  required: true;
  options?: { value: string; label: string }[];
};

export type GreenhouseRunResult =
  | { ok: true; status: 'opened' | 'applied' }
  | { ok: false; status: 'needs_input'; missingFields: ReportedField[] }
  | { ok: false; status: 'failed'; error: string };

export function isGreenhouseApplyUrl(url: string, _source?: string): boolean {
  return /greenhouse\.io/i.test(url) || /[?&]gh_jid=\d+/i.test(url);
}

/** Prefer direct Greenhouse embed over company search pages (e.g. Stripe gh_jid). */
export function resolveGreenhouseNavigationUrl(applyUrl: string): string {
  const ghJid = applyUrl.match(/[?&]gh_jid=(\d+)/i)?.[1];
  if (!ghJid) {
    return applyUrl;
  }

  if (/stripe\.com/i.test(applyUrl)) {
    return `https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=${ghJid}`;
  }

  const boardMatch = applyUrl.match(
    /(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i,
  );
  if (boardMatch) {
    return `https://job-boards.greenhouse.io/embed/job_app?for=${boardMatch[1]}&token=${boardMatch[2]}`;
  }

  return applyUrl;
}

/**
 * Fill standard Greenhouse job application form and optionally submit.
 */
export async function runGreenhouseApply(
  payload: ApplyJobPayload,
): Promise<GreenhouseRunResult> {
  let browser: Browser | null = null;
  let resumePath: string | null = null;

  try {
    if (!config.applyWorkerSecret) {
      throw new Error('APPLY_WORKER_SECRET is required for greenhouse mode');
    }

    const applicant = await fetchApplicantContext(payload.userId, payload.jobId);
    resumePath = await downloadResumeToTempFile(
      payload.userId,
      applicant.resumeFileName,
    );

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

    const navigationUrl = resolveGreenhouseNavigationUrl(payload.applyUrl);
    if (navigationUrl !== payload.applyUrl) {
      console.log(`[greenhouse] resolved ${payload.applyUrl} -> ${navigationUrl}`);
    }

    const response = await page.goto(navigationUrl, {
      waitUntil: 'load',
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

    const formRoot = await resolveGreenhouseFormRoot(page, navigationUrl);
    await fillGreenhouseForm(formRoot, applicant, resumePath);

    const coreEmpty = await verifyCoreApplicantFields(formRoot, applicant);
    if (coreEmpty.length > 0) {
      console.log(
        `[greenhouse] core applicant fields still empty after fill: ${coreEmpty.join(', ')}`,
      );
      return {
        ok: false,
        status: 'failed',
        error: `Could not fill required applicant fields: ${coreEmpty.join(', ')}`,
      };
    }

    const missingFields = await detectMissingRequiredFields(formRoot);
    if (missingFields.length > 0) {
      console.log(
        `[greenhouse] ${missingFields.length} required field(s) still missing — needs input`,
      );
      for (const field of missingFields) {
        console.log(
          `[greenhouse]   missing: name="${field.key}" type=${field.type} label="${field.label}"`,
        );
      }
      return { ok: false, status: 'needs_input', missingFields };
    }

    if (config.applySubmit) {
      await submitGreenhouseForm(formRoot, page);

      const securityResult = await handleSecurityCodeStep(
        formRoot,
        page,
        applicant.answers,
      );
      if (securityResult) {
        return securityResult;
      }

      const confirmed = await confirmGreenhouseSubmission(formRoot, page);
      if (process.env.DEBUG_SUBMIT_DUMP === '1') {
        await dumpPostSubmitState(page, formRoot);
      }
      if (!confirmed) {
        const reason = await describeSubmitFailure(formRoot, page);
        console.log(`[greenhouse] submit not confirmed: ${reason}`);
        return {
          ok: false,
          status: 'failed',
          error: `Submit not confirmed: ${reason}`,
        };
      }
      console.log('[greenhouse] submission confirmed');
      return { ok: true, status: 'applied' };
    }

    return { ok: true, status: 'opened' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 'failed', error: message };
  } finally {
    if (resumePath) {
      await removeTempFile(resumePath);
    }
    if (browser) {
      await browser.close();
    }
  }
}

type FormScope = Page | FrameLocator | Locator;

const FORM_FIELD_WAIT =
  '#first_name, #last_name, #email, input[type="email"], input[name*="first_name" i]';

const FIRST_NAME_SELECTORS = [
  '#first_name',
  'input[name="job_application[first_name]"]',
  'input[autocomplete="given-name"]',
  'input[aria-label*="first name" i]',
  'input[name*="first_name" i]',
];

const LAST_NAME_SELECTORS = [
  '#last_name',
  'input[name="job_application[last_name]"]',
  'input[autocomplete="family-name"]',
  'input[aria-label*="last name" i]',
  'input[name*="last_name" i]',
];

const EMAIL_SELECTORS = [
  '#email',
  'input[type="email"]',
  'input[name="job_application[email]"]',
  'input[autocomplete="email"]',
  'input[name="email"]',
];

const PHONE_SELECTORS = [
  '#phone',
  'input[type="tel"]',
  'input[name="job_application[phone]"]',
  'input[autocomplete="tel"]',
  'input[name*="phone" i]',
];

const LOCATION_SELECTORS = [
  '#candidate-location',
  '#candidate_location',
  'input[name="candidate_location"]',
  'input[id*="candidate-location" i]',
  'input[name*="location" i]',
];

const GREENHOUSE_SECURITY_CODE_KEY = 'greenhouse_security_code';

function nationalPhoneDigits(rawPhone: string): string {
  const trimmed = rawPhone.trim();
  if (trimmed.startsWith('+')) {
    return trimmed.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');
  }
  return trimmed.replace(/\D/g, '').replace(/^0+/, '');
}

/** Fill phone dial-code country (#country react-select) then the national number. */
async function fillPhoneField(
  formRoot: FormScope,
  rawPhone: string,
  applicant: ApplicantContext,
): Promise<boolean> {
  const countryName = applicant.phoneCountry?.trim();
  const national = nationalPhoneDigits(rawPhone);

  if (countryName) {
    let countryOk = await fillSelectByLabel(formRoot, 'country', countryName);
    if (!countryOk || !(await verifyPhoneCountry(formRoot, countryName))) {
      countryOk = await fillSelectByLabel(formRoot, 'country', countryName);
    }
    if (countryOk && (await verifyPhoneCountry(formRoot, countryName))) {
      console.log(`[fill] ✓ phone country select ${countryName}`);
    } else {
      const selected = await readReactSelectValue(formRoot, 'country');
      console.log(
        `[fill] ⚠ phone country select not set (target: ${countryName}, got: "${selected}")`,
      );
    }
  } else {
    console.log('[fill] ⚠ phoneCountry not provided by backend — country code may be missing');
  }

  return fillInputVerified(formRoot, ['#phone', ...PHONE_SELECTORS], national, 'phone');
}

async function fillCoreApplicantFields(
  formRoot: FormScope,
  applicant: ApplicantContext,
): Promise<void> {
  const firstNameOk = await fillInputVerified(
    formRoot,
    FIRST_NAME_SELECTORS,
    applicant.firstName,
    'first_name',
  );
  console.log(`[fill] ${firstNameOk ? '✓' : '✗'} first_name`);

  const lastNameOk = await fillInputVerified(
    formRoot,
    LAST_NAME_SELECTORS,
    applicant.lastName,
    'last_name',
  );
  console.log(`[fill] ${lastNameOk ? '✓' : '✗'} last_name`);

  const emailOk = await fillInputVerified(
    formRoot,
    EMAIL_SELECTORS,
    applicant.email,
    'email',
  );
  console.log(`[fill] ${emailOk ? '✓' : '✗'} email`);
}

async function waitForGreenhouseFields(scope: FormScope): Promise<void> {
  await scope.locator(FORM_FIELD_WAIT).first().waitFor({
    state: 'visible',
    timeout: config.navigationTimeoutMs,
  });
}

/** Page, iframe, or embed container where Greenhouse fields live. */
async function resolveGreenhouseFormRoot(
  page: Page,
  navigationUrl: string,
): Promise<FormScope> {
  if (/job-boards\.greenhouse\.io\/embed\//i.test(navigationUrl)) {
    await waitForGreenhouseFields(page);
    return page;
  }

  if (/stripe\.com/i.test(navigationUrl) && !navigationUrl.includes('/apply')) {
    const applyLink = page.locator(
      'a[href*="/apply"], [data-js-target*="applyNow"]',
    ).first();
    await applyLink.waitFor({
      state: 'visible',
      timeout: config.navigationTimeoutMs,
    });
    await applyLink.click();
    await page.waitForURL(/\/apply(?:\?|#|$)/, {
      timeout: config.navigationTimeoutMs,
    });
  }

  const isStripe =
    /stripe\.com/i.test(navigationUrl) || /stripe\.com/i.test(page.url());

  if (isStripe) {
    await page.locator('#grnhse_app').waitFor({
      state: 'attached',
      timeout: config.navigationTimeoutMs,
    });

    const iframe = page.locator('#grnhse_app iframe').first();
    try {
      await iframe.waitFor({
        state: 'attached',
        timeout: config.navigationTimeoutMs,
      });
      const frame = page.frameLocator('#grnhse_app iframe').first();
      await waitForGreenhouseFields(frame);
      return frame;
    } catch {
      const container = page.locator('#grnhse_app');
      await waitForGreenhouseFields(container);
      return container;
    }
  }

  const genericIframe = page.locator('iframe[src*="greenhouse"]').first();
  if ((await genericIframe.count()) > 0) {
    await genericIframe.waitFor({
      state: 'attached',
      timeout: config.navigationTimeoutMs,
    });
    const frame = page.frameLocator('iframe[src*="greenhouse"]').first();
    await waitForGreenhouseFields(frame);
    return frame;
  }

  await waitForGreenhouseFields(page);
  return page;
}

async function fillGreenhouseForm(
  formRoot: FormScope,
  applicant: ApplicantContext,
  resumePath: string,
): Promise<void> {
  const answerKeys = Object.keys(applicant.answers).filter(
    (k) => !k.startsWith('lbl_'),
  );
  console.log(
    `[fill] received ${answerKeys.length} answer(s) from backend: ${answerKeys.join(', ')}` +
      (applicant.phoneCountry ? ` | phoneCountry=${applicant.phoneCountry}` : ''),
  );

  // Job-specific answers first — react-select interactions can wipe earlier
  // React-controlled text inputs (first/last name, email).
  await fillGreenhouseAnswers(formRoot, applicant.answers);

  const phone =
    (typeof applicant.answers.phone === 'string' && applicant.answers.phone) ||
    config.defaultPhone;
  if (phone) {
    const phoneOk = await fillPhoneField(formRoot, phone, applicant);
    console.log(`[fill] ${phoneOk ? '✓' : '✗'} phone (incl. country code)`);
  }

  const location =
    typeof applicant.answers.candidate_location === 'string'
      ? applicant.answers.candidate_location
      : '';
  if (location) {
    const locationOk = await fillLocationField(formRoot, location);
    console.log(`[fill] ${locationOk ? '✓' : '✗'} candidate_location`);
  }

  const fileInput = formRoot.locator(
    'input[type="file"]#resume, input[type="file"][name*="resume" i], input[type="file"]',
  ).first();
  await fileInput.setInputFiles(resumePath);

  // Core identity fields last so they stay populated through submit.
  await fillCoreApplicantFields(formRoot, applicant);
}

/**
 * Walk the live form and return required fields that are still empty after the
 * automated fill pass. Best-effort across native inputs, selects, and
 * react-select comboboxes. Core auto-filled fields are ignored.
 */
async function detectMissingRequiredFields(
  formRoot: FormScope,
): Promise<ReportedField[]> {
  const controls = formRoot.locator(
    'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea, select, .select__control',
  );

  const raw = (await controls.evaluateAll((elements) => {
    const CORE = /(first_name|last_name|email|resume|phone|location)/i;
    // Names injected by helper widgets (intl phone input, react-select search)
    // that are never real application questions.
    const NOISE_NAME =
      /(__search-input|^iti-|country-search|^country$|^undefined$)/i;
    const CORE_LABEL =
      /^(first name|last name|full name|email|phone|resume|country)\s*$/i;
    const results: Array<{
      key: string;
      label: string;
      type: string;
      required: true;
      options?: { value: string; label: string }[];
    }> = [];
    const seen = new Set<string>();

    for (const el of elements) {
      // A react-select renders its own search/value <input> inside a
      // `.select__control`. Only evaluate the control itself; skip the inner
      // input, otherwise a filled dropdown is double-counted as an empty text
      // field with the same name.
      if (
        !el.classList.contains('select__control') &&
        typeof el.closest === 'function' &&
        el.closest('.select__control')
      ) {
        continue;
      }

      // Resolve the field label inline (no named helper, to avoid the tsx/esbuild
      // "__name" keepNames wrapper leaking into the browser page context).
      let rawLabel = '';
      let node: Element | null = el;
      for (let i = 0; i < 6 && node; i += 1) {
        const lbl = node.querySelector ? node.querySelector('label') : null;
        if (lbl && lbl.textContent && lbl.textContent.trim()) {
          rawLabel = lbl.textContent.trim();
          break;
        }
        node = node.parentElement;
      }
      if (!rawLabel) {
        const id = (el as HTMLElement).id;
        if (id) {
          const forLbl = document.querySelector(`label[for="${id}"]`);
          if (forLbl && forLbl.textContent) {
            rawLabel = forLbl.textContent.trim();
          }
        }
      }
      if (!rawLabel) {
        const aria = el.getAttribute('aria-label');
        if (aria) {
          rawLabel = aria.trim();
        }
      }

      const tag = el.tagName.toLowerCase();
      let name = '';
      let empty = false;
      let type = 'text';
      let requiredAttr = false;
      let options: { value: string; label: string }[] | undefined;

      if (el.classList.contains('select__control')) {
        type = 'select';
        const hasValue = !!el.querySelector(
          '.select__single-value, .select__multi-value',
        );
        empty = !hasValue;
        const inner = el.querySelector('input');
        name = inner
          ? inner.getAttribute('name') || inner.id || ''
          : '';
        requiredAttr = inner
          ? inner.getAttribute('aria-required') === 'true'
          : false;
      } else {
        const input = el as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement;
        name = input.getAttribute('name') || input.id || '';
        requiredAttr =
          (input as HTMLInputElement).required ||
          input.getAttribute('aria-required') === 'true';

        if (tag === 'select') {
          type = 'select';
          const sel = input as HTMLSelectElement;
          empty = !sel.value;
          options = Array.from(sel.options)
            .filter((o) => o.value)
            .map((o) => ({
              value: o.value,
              label: (o.textContent || o.value).trim(),
            }));
        } else if (tag === 'textarea') {
          type = 'textarea';
          empty = !(input as HTMLTextAreaElement).value.trim();
        } else {
          const it = (input as HTMLInputElement).type || 'text';
          type = it;
          if (it === 'checkbox' || it === 'radio') {
            if (seen.has(name)) {
              continue;
            }

            const anyChecked = name
              ? !!document.querySelector(`input[name="${name}"]:checked`)
              : false;
            empty = !anyChecked;

            // Individual checkbox labels (e.g. "Australia") are options, not
            // the question. Resolve the group question from fieldset/parent.
            if (it === 'checkbox' && name.endsWith('[]')) {
              type = 'multi_select';
              let groupLabel = rawLabel;
              const fieldset = el.closest('fieldset');
              const legend = fieldset?.querySelector('legend');
              if (legend?.textContent?.trim()) {
                groupLabel = legend.textContent.trim();
              }
              if (!groupLabel.includes('?')) {
                let parent: Element | null = el.parentElement;
                for (let depth = 0; depth < 8 && parent; depth += 1) {
                  const scopeLabel = parent.querySelector(
                    ':scope > label, :scope > .label, legend, h3, h4',
                  );
                  const text = scopeLabel?.textContent?.trim() ?? '';
                  if (text.includes('?') && text.length > groupLabel.length) {
                    groupLabel = text;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }
              rawLabel = groupLabel;

              const boxes = document.querySelectorAll(
                `input[type="checkbox"][name="${name}"]`,
              );
              options = Array.from(boxes).map((box) => {
                const cb = box as HTMLInputElement;
                let optLabel = cb.value;
                const cbId = cb.id;
                if (cbId) {
                  const lbl = document.querySelector(`label[for="${cbId}"]`);
                  if (lbl?.textContent?.trim()) {
                    optLabel = lbl.textContent.trim();
                  }
                }
                return { value: cb.value, label: optLabel };
              });
            }
          } else {
            empty = !(input as HTMLInputElement).value.trim();
          }
        }
      }

      const label = (rawLabel || name).replace(/\s*\*\s*$/, '').trim();
      const required =
        requiredAttr || /\*\s*$/.test(rawLabel) || rawLabel.includes('*');

      if (!name || !required || !empty) {
        continue;
      }
      if (CORE.test(name) || NOISE_NAME.test(name)) {
        continue;
      }
      if (CORE_LABEL.test(label)) {
        continue;
      }
      // Skip controls that are not actually visible/interactable.
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);

      results.push({ key: name, label, type, required: true, options });
    }

    return results;
  })) as ReportedField[];

  return raw;
}

async function fillFirstMatch(
  formRoot: FormScope,
  selectors: string[],
  value: string,
): Promise<boolean> {
  return fillInputVerified(formRoot, selectors, value, selectors[0] ?? 'field');
}

/**
 * Set a React-controlled input by id using the native value setter so the
 * value survives Greenhouse's controlled component re-renders.
 */
async function setReactInputById(
  formRoot: FormScope,
  elementId: string,
  value: string,
): Promise<boolean> {
  const field = formRoot.locator(`#${cssAttr(elementId)}`).first();
  if ((await field.count()) === 0) {
    return false;
  }
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }

  return field.evaluate((el, val) => {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const proto =
      input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return input.value === val;
  }, value);
}

/**
 * Fill a text input and confirm the value actually landed in the DOM.
 * React-controlled Greenhouse fields often ignore a single fill() call.
 */
async function fillInputVerified(
  formRoot: FormScope,
  selectors: string[],
  value: string,
  fieldName: string,
): Promise<boolean> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  for (const selector of selectors) {
    const idMatch = selector.match(/^#([\w-]+)$/);
    if (idMatch) {
      if (await setReactInputById(formRoot, idMatch[1], trimmed)) {
        const field = formRoot.locator(selector).first();
        if (await inputMatches(field, trimmed)) {
          return true;
        }
      }
    }

    const field = formRoot.locator(selector).first();
    if ((await field.count()) === 0) {
      continue;
    }
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    if (await field.isDisabled().catch(() => false)) {
      continue;
    }

    try {
      await field.scrollIntoViewIfNeeded().catch(() => undefined);
      await field.click({ timeout: 5_000 });
      await field.fill('');
      await field.fill(trimmed);

      if (await inputMatches(field, trimmed)) {
        return true;
      }

      // React controlled inputs: select-all + type character-by-character.
      await field.click();
      await field.press('ControlOrMeta+a').catch(() => undefined);
      await field.pressSequentially(trimmed, { delay: 15 });

      if (await inputMatches(field, trimmed)) {
        return true;
      }

      console.log(
        `[fill] ${fieldName}: fill() did not stick on ${selector} (got "${await field.inputValue().catch(() => '')}")`,
      );
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function inputMatches(
  field: Locator,
  expected: string,
): Promise<boolean> {
  const actual = (await field.inputValue().catch(() => '')).trim();
  if (actual.toLowerCase() === expected.trim().toLowerCase()) {
    return true;
  }
  // Phone inputs may insert spacing/grouping (e.g. "81258 59799").
  const actualDigits = actual.replace(/\D/g, '');
  const expectedDigits = expected.replace(/\D/g, '');
  return (
    actualDigits.length > 0 &&
    (actualDigits === expectedDigits || actualDigits.endsWith(expectedDigits))
  );
}

/** Pick the best react-select option for a label (avoids "India" → British Indian Ocean Territory). */
async function clickBestSelectOption(
  options: Locator,
  optionText: string,
): Promise<boolean> {
  const count = await options.count();
  if (count === 0) {
    return false;
  }

  const wanted = optionText.trim();
  const wantedLower = wanted.toLowerCase();
  const texts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    texts.push(
      ((await options.nth(i).innerText().catch(() => '')) || '').trim(),
    );
  }

  const pick = async (index: number): Promise<boolean> => {
    await options.nth(index).click({ timeout: 5_000 }).catch(() => undefined);
    return true;
  };

  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i].toLowerCase() === wantedLower) {
      return pick(i);
    }
  }

  // Greenhouse country options look like "India +91".
  const prefixRe = new RegExp(
    `^\\s*${regexEscape(wanted)}(?:\\s|\\+|,|$)`,
    'i',
  );
  for (let i = 0; i < texts.length; i += 1) {
    if (prefixRe.test(texts[i])) {
      return pick(i);
    }
  }

  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i].toLowerCase().startsWith(`${wantedLower},`)) {
      return pick(i);
    }
  }

  return false;
}

async function readReactSelectValue(
  formRoot: FormScope,
  fieldId: string,
): Promise<string> {
  const escapedId = cssAttr(fieldId);
  const input = formRoot.locator(`#${escapedId}.select__input`).first();
  if ((await input.count()) === 0) {
    return '';
  }
  const control = input
    .locator('xpath=preceding-sibling::div[contains(@class,"select__control")][1]')
    .first();
  if ((await control.count()) === 0) {
    return '';
  }
  const single = control.locator('.select__single-value').first();
  if ((await single.count()) > 0) {
    const singleText = ((await single.innerText().catch(() => '')) || '').trim();
    if (singleText) {
      return singleText;
    }
  }
  return ((await control.innerText().catch(() => '')) || '').trim();
}

/**
 * Greenhouse location is a geocoding autocomplete — typing the city name alone
 * is rejected until a suggestion like "Visakhapatnam, Andhra Pradesh, India"
 * is selected from the dropdown.
 */
async function fillLocationField(
  formRoot: FormScope,
  location: string,
): Promise<boolean> {
  const fieldId = 'candidate-location';
  const trimmed = location.trim();
  if (!trimmed) {
    return false;
  }

  const input = formRoot
    .locator(`#${cssAttr(fieldId)}.select__input, #${cssAttr(fieldId)}`)
    .first();
  if ((await input.count()) === 0) {
    return false;
  }
  if (!(await input.isVisible().catch(() => false))) {
    return false;
  }

  await input.click();
  await input.fill('');
  await input.pressSequentially(trimmed, { delay: 30 });

  let options = selectOptionsLocator(formRoot);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if ((await options.count()) > 0) {
      break;
    }
    await delay(250);
  }

  if ((await options.count()) === 0) {
    return false;
  }

  if (await clickBestLocationOption(options, trimmed)) {
    await delay(300);
    if (await verifyLocationSelected(formRoot, trimmed)) {
      return true;
    }
  }

  await input.click();
  await input.press('ArrowDown').catch(() => undefined);
  await input.press('Enter').catch(() => undefined);
  await delay(300);
  return verifyLocationSelected(formRoot, trimmed);
}

async function verifyLocationSelected(
  formRoot: FormScope,
  location: string,
): Promise<boolean> {
  const selected = await readReactSelectValue(formRoot, 'candidate-location');
  if (!selected) {
    return false;
  }
  const wanted = location.trim().toLowerCase();
  const selectedLower = selected.toLowerCase();
  if (selectedLower === wanted) {
    return true;
  }
  if (selectedLower.startsWith(`${wanted},`)) {
    return true;
  }
  return selectedLower.includes(wanted);
}

/** Prefer "City, Region, Country" over "City Rural, ..." for geocoding autocompletes. */
async function clickBestLocationOption(
  options: Locator,
  cityText: string,
): Promise<boolean> {
  const count = await options.count();
  if (count === 0) {
    return false;
  }

  const wanted = cityText.trim();
  const wantedLower = wanted.toLowerCase();
  const texts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    texts.push(
      ((await options.nth(i).innerText().catch(() => '')) || '').trim(),
    );
  }

  const pick = async (index: number): Promise<boolean> => {
    await options.nth(index).click({ timeout: 5_000 }).catch(() => undefined);
    return true;
  };

  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i].toLowerCase() === wantedLower) {
      return pick(i);
    }
  }

  const cityCommaRe = new RegExp(`^${regexEscape(wanted)}\\s*,`, 'i');
  const commaMatches: number[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    if (cityCommaRe.test(texts[i])) {
      commaMatches.push(i);
    }
  }
  if (commaMatches.length === 1) {
    return pick(commaMatches[0]);
  }
  if (commaMatches.length > 1) {
    let best = commaMatches[0];
    for (const idx of commaMatches) {
      if (texts[idx].length < texts[best].length) {
        best = idx;
      }
    }
    return pick(best);
  }

  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i].toLowerCase().startsWith(`${wantedLower},`)) {
      return pick(i);
    }
  }

  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i].toLowerCase().startsWith(wantedLower)) {
      return pick(i);
    }
  }

  return pick(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function verifyPhoneCountry(
  formRoot: FormScope,
  countryName: string,
): Promise<boolean> {
  const selected = await readReactSelectValue(formRoot, 'country');
  if (selected) {
    const prefixRe = new RegExp(
      `^\\s*${regexEscape(countryName.trim())}(?:\\s|\\+|,|$)|\\+91`,
      'i',
    );
    if (prefixRe.test(selected)) {
      return true;
    }
    if (/india/i.test(countryName) && /\+91/.test(selected)) {
      return true;
    }
  }

  const countryInput = formRoot.locator('#country').first();
  if ((await countryInput.count()) === 0) {
    return false;
  }
  const ariaInvalid = await countryInput.getAttribute('aria-invalid').catch(() => null);
  return ariaInvalid !== 'true';
}

/** Options for react-select menus (often portaled to document body). */
function selectOptionsLocator(formRoot: FormScope): Locator {
  // Page and FrameLocator both support locator(); portaled menus are on the page.
  return formRoot.locator('.select__option, [role="option"]');
}

async function readInputValue(
  formRoot: FormScope,
  selectors: string[],
): Promise<string> {
  for (const selector of selectors) {
    const field = formRoot.locator(selector).first();
    if ((await field.count()) === 0) {
      continue;
    }
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const value = (await field.inputValue().catch(() => '')).trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/** Confirm first name, last name, and email are non-empty in the live form. */
async function verifyCoreApplicantFields(
  formRoot: FormScope,
  applicant: ApplicantContext,
): Promise<string[]> {
  const empty: string[] = [];

  const first = await readInputValue(formRoot, FIRST_NAME_SELECTORS);
  if (!first) {
    empty.push('first_name');
  }

  const last = await readInputValue(formRoot, LAST_NAME_SELECTORS);
  if (!last) {
    empty.push('last_name');
  }

  const email = await readInputValue(formRoot, EMAIL_SELECTORS);
  if (!email) {
    empty.push('email');
  }

  if (empty.length > 0) {
    console.log(
      `[fill] core field values in DOM: first="${first}" last="${last}" email="${email}" (applicant: ${applicant.firstName} ${applicant.lastName})`,
    );
  }

  return empty;
}

/**
 * Best-effort check that Greenhouse accepted the submission.
 * Checks form scope and top-level page (Stripe embed may render confirmation outside iframe).
 */
async function confirmGreenhouseSubmission(
  formRoot: FormScope,
  page: Page,
): Promise<boolean> {
  await waitForPostSubmitSettle(page, formRoot);

  if (await hasValidationErrors(formRoot, page)) {
    return false;
  }

  if (await hasSubmissionConfirmation(formRoot, page)) {
    return true;
  }

  // Submit control gone/disabled often means the form was replaced by confirmation.
  if (await submitControlAbsent(formRoot, page)) {
    return true;
  }

  return false;
}

async function waitForPostSubmitSettle(
  page: Page,
  formRoot: FormScope,
): Promise<void> {
  await Promise.race([
    page
      .waitForURL(/confirmation|thank|success|submitted/i, { timeout: 12_000 })
      .catch(() => undefined),
    formRoot
      .locator(
        '#application_confirmation, .application-confirmation, [data-testid="application-confirmation"], .confirmation, text=/thank you for applying/i, text=/application (was )?submitted/i, text=/your application has been received/i, text=/successfully submitted/i, text=/we.ll be in touch/i',
      )
      .first()
      .waitFor({ state: 'visible', timeout: 12_000 })
      .catch(() => undefined),
    page.waitForTimeout(3_000),
  ]);
}

async function hasValidationErrors(
  formRoot: FormScope,
  page: Page,
): Promise<boolean> {
  const errorLocator = (scope: FormScope) =>
    scope.locator(
      '.field-error, .error-message, [class*="field-error"], [class*="error-banner"], [class*="helper-text--error"], .invalid-feedback',
    );

  for (const scope of [formRoot, page]) {
    const errors = errorLocator(scope);
    const count = await errors.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const err = errors.nth(i);
      const visible = await err.isVisible().catch(() => false);
      if (!visible) continue;
      const text = ((await err.innerText().catch(() => '')) || '').trim();
      if (!text) continue;
      console.log(
        `[greenhouse] validation error after submit: ${text.slice(0, 200)}`,
      );
      return true;
    }
  }

  const bodyText = await page
    .evaluate(() => document.body?.innerText ?? '')
    .catch(() => '');
  if (/phone number is too long|phone number is too short|invalid phone|please enter your location/i.test(bodyText)) {
    console.log('[greenhouse] validation error after submit: form field invalid');
    return true;
  }

  return false;
}

const CONFIRMATION_LOCATOR =
  '#application_confirmation, .application-confirmation, [data-testid="application-confirmation"], .confirmation, [class*="confirmation"], [class*="thank-you"], text=/thank you for applying/i, text=/application (was )?submitted/i, text=/your application has been received/i, text=/successfully submitted/i, text=/we.ll be in touch/i, text=/thanks for applying/i';

async function hasSubmissionConfirmation(
  formRoot: FormScope,
  page: Page,
): Promise<boolean> {
  for (const scope of [formRoot, page]) {
    const confirmation = scope.locator(CONFIRMATION_LOCATOR).first();
    if (
      await confirmation
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      return true;
    }
  }

  const bodyText = await page
    .evaluate(() => document.body?.innerText ?? '')
    .catch(() => '');
  if (
    /thank you for applying|application (was )?submitted|your application has been received|successfully submitted|thanks for applying/i.test(
      bodyText,
    )
  ) {
    return true;
  }

  return false;
}

async function submitControlAbsent(
  formRoot: FormScope,
  page: Page,
): Promise<boolean> {
  const submitSelector =
    '#submit_app, button[type="submit"], input[type="submit"], [data-testid="submit-application"]';

  for (const scope of [formRoot, page]) {
    const submit = scope.locator(submitSelector);
    const count = await submit.count().catch(() => 1);
    if (count === 0) {
      return true;
    }
    const visible = await submit
      .first()
      .isVisible()
      .catch(() => true);
    if (!visible) {
      return true;
    }
    const disabled = await submit
      .first()
      .isDisabled()
      .catch(() => false);
    if (disabled) {
      // Disabled submit after click can mean processing — not confirmation.
      continue;
    }
  }
  return false;
}

async function describeSubmitFailure(
  formRoot: FormScope,
  page: Page,
): Promise<string> {
  if (await hasValidationErrors(formRoot, page)) {
    return 'validation errors on form';
  }

  const submit = formRoot
    .locator('#submit_app, button[type="submit"], input[type="submit"]')
    .first();
  if ((await submit.count()) > 0 && (await submit.isVisible().catch(() => false))) {
    const disabled = await submit.isDisabled().catch(() => false);
    if (disabled) {
      return 'submit button still disabled';
    }
    return 'submit button still visible — form may not have submitted';
  }

  return 'no confirmation message detected';
}

function getSecurityCodeFromAnswers(
  answers: Record<string, string | string[]>,
): string | null {
  const raw = answers[GREENHOUSE_SECURITY_CODE_KEY];
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().replace(/\s/g, '').toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

async function detectSecurityCodeChallenge(
  formRoot: FormScope,
  page: Page,
): Promise<ReportedField | null> {
  await page.waitForTimeout(1_000);

  const boxes = formRoot.locator('[id^="security-input-"]');
  if ((await boxes.count().catch(() => 0)) > 0) {
    return {
      key: GREENHOUSE_SECURITY_CODE_KEY,
      label: 'Security code (check your email)',
      type: 'text',
      required: true,
    };
  }

  const bodyText = await page
    .evaluate(() => document.body?.innerText ?? '')
    .catch(() => '');
  if (
    /security code|verification code|enter the code|copy and paste this code|resubmit your application/i.test(
      bodyText,
    )
  ) {
    await page.waitForTimeout(1_500);
    if ((await formRoot.locator('[id^="security-input-"]').count()) > 0) {
      return {
        key: GREENHOUSE_SECURITY_CODE_KEY,
        label: 'Security code (check your email)',
        type: 'text',
        required: true,
      };
    }
  }

  return null;
}

/**
 * Greenhouse renders the code as 8 single-character inputs (#security-input-0 … 7).
 * Use native value setters — Playwright fill/type is unreliable on these boxes.
 */
async function fillSecurityCode(page: Page, code: string): Promise<boolean> {
  const normalized = code.replace(/\s/g, '').toUpperCase();
  if (!normalized) {
    return false;
  }

  const filledCount = await page.evaluate((value) => {
    const chars = value.split('');
    let count = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const el = document.getElementById(
        `security-input-${i}`,
      ) as HTMLInputElement | null;
      if (!el) {
        break;
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter) {
        setter.call(el, chars[i]);
      } else {
        el.value = chars[i];
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      count += 1;
    }
    return count;
  }, normalized);

  if (filledCount > 0) {
    console.log(`[fill] ✓ security code (${filledCount} character(s))`);
    return true;
  }

  return false;
}

async function handleSecurityCodeStep(
  formRoot: FormScope,
  page: Page,
  answers: Record<string, string | string[]>,
): Promise<GreenhouseRunResult | null> {
  const challenge = await detectSecurityCodeChallenge(formRoot, page);
  if (!challenge) {
    return null;
  }

  const code = getSecurityCodeFromAnswers(answers);
  if (!code) {
    console.log(
      '[greenhouse] email security code required — enter the code from your inbox',
    );
    return { ok: false, status: 'needs_input', missingFields: [challenge] };
  }

  const filled = await fillSecurityCode(page, code);
  if (!filled) {
    console.log('[greenhouse] could not fill security code inputs');
    return { ok: false, status: 'needs_input', missingFields: [challenge] };
  }

  await submitGreenhouseForm(formRoot, page);

  const stillNeeded = await detectSecurityCodeChallenge(formRoot, page);
  if (stillNeeded) {
    console.log(
      '[greenhouse] security code rejected or expired — enter the latest code from email',
    );
    return { ok: false, status: 'needs_input', missingFields: [challenge] };
  }

  return null;
}

async function dumpPostSubmitState(
  page: Page,
  formRoot: FormScope,
): Promise<void> {
  const pageText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '')
    .catch(() => '');
  const submitCount = await formRoot
    .locator('#submit_app, button[type="submit"]')
    .count()
    .catch(() => -1);
  const confirmCount = await formRoot
    .locator(CONFIRMATION_LOCATOR)
    .count()
    .catch(() => -1);
  console.log('[debug] url:', page.url());
  console.log('[debug] submit buttons in formRoot:', submitCount);
  console.log('[debug] confirmation elements:', confirmCount);
  console.log('[debug] page text:', pageText.replace(/\s+/g, ' ').slice(0, 600));
}

async function submitGreenhouseForm(
  formRoot: FormScope,
  page: Page,
): Promise<void> {
  const submit = formRoot
    .locator(
      '#submit_app, button[type="submit"], input[type="submit"], [data-testid="submit-application"]',
    )
    .first();

  await submit.waitFor({ state: 'visible', timeout: 15_000 });
  await submit.scrollIntoViewIfNeeded().catch(() => undefined);

  // Wait until enabled (Greenhouse disables submit while required fields validate).
  await page
    .waitForFunction(
      () => {
        const btn =
          document.querySelector<HTMLButtonElement>(
            '#submit_app, button[type="submit"], input[type="submit"]',
          );
        return btn && !btn.disabled;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const responsePromise = page
    .waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        (/greenhouse\.io/i.test(res.url()) ||
          /applications?/i.test(res.url())),
      { timeout: 20_000 },
    )
    .catch(() => null);

  await submit.click({ timeout: 15_000 });
  await responsePromise;
  await page.waitForTimeout(1_000);
}

const SKIP_ANSWER_KEYS = new Set([
  'first_name',
  'last_name',
  'email',
  'phone',
  'candidate_location',
  'resume',
  'resume_text',
  GREENHOUSE_SECURITY_CODE_KEY,
]);

/** Escape a value for safe use inside a quoted CSS attribute selector. */
function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fillGreenhouseAnswers(
  formRoot: FormScope,
  answers: Record<string, string | string[]>,
): Promise<void> {
  const filled: string[] = [];
  const notFilled: string[] = [];

  for (const [key, rawValue] of Object.entries(answers)) {
    if (SKIP_ANSWER_KEYS.has(key)) {
      continue;
    }
    // Canonical `lbl_<hash>` keys are backend mirrors; the live DOM only uses
    // the raw form field names, so skip them to keep logs meaningful.
    if (key.startsWith('lbl_')) {
      continue;
    }

    const preview = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : (rawValue ?? '').trim();

    try {
      let ok = false;
      let method = '';

      if (Array.isArray(rawValue)) {
        ok = await fillCheckboxGroup(formRoot, key, rawValue);
        method = 'checkbox-group';
      } else {
        const value = rawValue?.trim();
        if (!value) {
          continue;
        }

        if (key.endsWith('[]')) {
          ok = await fillCheckboxGroup(formRoot, key, [value]);
          method = 'checkbox-group';
        } else if (await isReactSelectField(formRoot, key)) {
          ok = await fillSelectByLabel(formRoot, key, value);
          method = 'select';
        } else if (await fillSelectByLabel(formRoot, key, value)) {
          ok = true;
          method = 'select';
        } else if (await fillChoiceByValue(formRoot, key, value)) {
          ok = true;
          method = 'choice';
        } else {
          const escaped = cssAttr(key);
          ok = await fillInputVerified(
            formRoot,
            [
              `input[id="${escaped}"]`,
              `textarea[id="${escaped}"]`,
              `input[name="${escaped}"]`,
              `textarea[name="${escaped}"]`,
            ],
            value,
            key,
          );
          method = 'text';
        }
      }

      if (ok) {
        filled.push(key);
        console.log(`[fill] ✓ ${key} = "${preview}" (${method})`);
      } else {
        notFilled.push(key);
        console.log(
          `[fill] ✗ ${key} = "${preview}" — no matching control found`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notFilled.push(key);
      console.warn(`[fill] ✗ ${key} — error: ${message}`);
    }
  }

  console.log(
    `[fill] summary: ${filled.length} filled, ${notFilled.length} not filled` +
      (notFilled.length ? ` → unfilled: ${notFilled.join(', ')}` : ''),
  );
}

async function fillCheckboxGroup(
  formRoot: FormScope,
  name: string,
  values: string[],
): Promise<boolean> {
  let checkedAny = false;
  const boxes = formRoot.locator(
    `input[type="checkbox"][name="${cssAttr(name)}"], input[type="radio"][name="${cssAttr(name)}"]`,
  );
  const count = await boxes.count();

  for (const value of values) {
    const wanted = value.trim().toLowerCase();
    let matched = false;

    for (let i = 0; i < count; i += 1) {
      const box = boxes.nth(i);
      const optionValue = ((await box.getAttribute('value')) || '')
        .trim()
        .toLowerCase();

      let labelText = '';
      const id = await box.getAttribute('id');
      if (id) {
        const lbl = formRoot.locator(`label[for="${cssAttr(id)}"]`).first();
        if ((await lbl.count()) > 0) {
          labelText = ((await lbl.innerText().catch(() => '')) || '')
            .trim()
            .toLowerCase();
        }
      }

      if (
        optionValue === wanted ||
        labelText === wanted ||
        (labelText.length > 0 && labelText.includes(wanted))
      ) {
        await box.check().catch(() => undefined);
        checkedAny = true;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Fallback: match by value attribute only.
      const byValue = formRoot
        .locator(
          `input[type="checkbox"][name="${cssAttr(name)}"][value="${cssAttr(value)}"], input[type="radio"][name="${cssAttr(name)}"][value="${cssAttr(value)}"]`,
        )
        .first();
      if ((await byValue.count()) > 0) {
        await byValue.check().catch(() => undefined);
        checkedAny = true;
      }
    }
  }

  return checkedAny;
}

/**
 * Fill a single-choice field expressed as a native <select>, radio group, or
 * checkbox group by matching the answer against option value or label text.
 * Returns true when a matching control was found and set.
 */
async function fillChoiceByValue(
  formRoot: FormScope,
  key: string,
  value: string,
): Promise<boolean> {
  const escaped = cssAttr(key);

  const nativeSelect = formRoot
    .locator(`select[id="${escaped}"], select[name="${escaped}"]`)
    .first();
  if ((await nativeSelect.count()) > 0) {
    const byLabel = await nativeSelect
      .selectOption({ label: value })
      .then(() => true)
      .catch(() => false);
    if (!byLabel) {
      return nativeSelect
        .selectOption(value)
        .then(() => true)
        .catch(() => false);
    }
    return true;
  }

  const choices = formRoot.locator(
    `input[type="radio"][name="${escaped}"], input[type="checkbox"][name="${escaped}"], input[type="radio"][id="${escaped}"], input[type="checkbox"][id="${escaped}"]`,
  );
  const count = await choices.count();
  const wanted = value.trim().toLowerCase();

  for (let i = 0; i < count; i += 1) {
    const choice = choices.nth(i);
    const optionValue = ((await choice.getAttribute('value')) || '')
      .trim()
      .toLowerCase();

    let labelText = '';
    const id = await choice.getAttribute('id');
    if (id) {
      const lbl = formRoot.locator(`label[for="${cssAttr(id)}"]`).first();
      if ((await lbl.count()) > 0) {
        labelText = ((await lbl.innerText().catch(() => '')) || '')
          .trim()
          .toLowerCase();
      }
    }

    if (
      optionValue === wanted ||
      labelText === wanted ||
      (labelText.length > 0 && labelText.includes(wanted))
    ) {
      await choice.check().catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function isReactSelectField(
  formRoot: FormScope,
  fieldId: string,
): Promise<boolean> {
  const input = formRoot.locator(`#${cssAttr(fieldId)}`).first();
  if ((await input.count()) === 0) {
    return false;
  }
  const className = (await input.getAttribute('class')) ?? '';
  return className.includes('select__input');
}

/**
 * Fill a Greenhouse react-select combobox. On Stripe/Greenhouse embeds the
 * field id lives on the `.select__input` itself (not inside `.select__control`).
 */
async function fillSelectByLabel(
  formRoot: FormScope,
  fieldId: string,
  optionText: string,
): Promise<boolean> {
  const escapedId = cssAttr(fieldId);
  const input = formRoot.locator(`#${escapedId}`).first();

  if ((await input.count()) > 0) {
    const className = (await input.getAttribute('class')) ?? '';
    if (className.includes('select__input')) {
      if (!(await input.isVisible().catch(() => false))) {
        return false;
      }

      await input.click();
      await input.fill('');
      await input.pressSequentially(optionText, { delay: 25 });

      await formRoot
        .locator('.select__menu, .select__menu-portal')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => undefined);

      const options = selectOptionsLocator(formRoot);
      if (await clickBestSelectOption(options, optionText)) {
        return true;
      }

      await input.press('ArrowDown').catch(() => undefined);
      await input.press('Enter').catch(() => undefined);
      return false;
    }
  }

  const control = await resolveSelectControl(formRoot, escapedId);
  if (!control) {
    return false;
  }
  if (!(await control.isVisible().catch(() => false))) {
    return false;
  }

  await control.click().catch(() => undefined);

  const searchInput = control.locator('input').first();
  await searchInput.fill('').catch(() => undefined);
  await searchInput.pressSequentially(optionText, { delay: 25 }).catch(() => undefined);

  await formRoot
    .locator('.select__menu, .select__menu-portal')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => undefined);

  const options = selectOptionsLocator(formRoot);
  if (await clickBestSelectOption(options, optionText)) {
    return true;
  }

  await control.press('Escape').catch(() => undefined);
  return false;
}

/**
 * Locate a react-select control for a Greenhouse field. Greenhouse sets the
 * search input id to the field name; the value is also mirrored in a hidden
 * input with the same name, so match either.
 */
async function resolveSelectControl(
  formRoot: FormScope,
  escapedId: string,
): Promise<Locator | null> {
  const byInner = formRoot
    .locator('.select__control')
    .filter({
      has: formRoot.locator(
        `input[id="${escapedId}"], input[name="${escapedId}"]`,
      ),
    })
    .first();
  if ((await byInner.count()) > 0) {
    return byInner;
  }

  // Greenhouse: id is on `.select__input`; control is a preceding sibling.
  const bySelectInput = formRoot.locator(`#${escapedId}.select__input`).first();
  if ((await bySelectInput.count()) > 0) {
    const siblingControl = bySelectInput
      .locator('xpath=preceding-sibling::div[contains(@class,"select__control")][1]')
      .first();
    if ((await siblingControl.count()) > 0) {
      return siblingControl;
    }
    return bySelectInput;
  }

  // Fall back to a wrapper that holds both the hidden input and the control.
  const byWrapper = formRoot
    .locator(`div:has(input[name="${escapedId}"])`)
    .filter({ has: formRoot.locator('.select__control') })
    .locator('.select__control')
    .first();
  if ((await byWrapper.count()) > 0) {
    return byWrapper;
  }

  return null;
}
