import { config } from '../config';

export function isTelegramSecurityCodeEnabled(applicant: {
  telegramConnected?: boolean;
  telegramChatId?: string;
}): boolean {
  return Boolean(applicant.telegramConnected || applicant.telegramChatId?.trim());
}

export async function waitForSecurityCodeViaBackend(params: {
  userId: string;
  company?: string;
  role?: string;
  applyUrl: string;
  timeoutMs: number;
  skipPrompt?: boolean;
}): Promise<string | null> {
  const url = `${config.apiPublicUrl}/api/v1/internal/apply/users/${params.userId}/telegram/wait-security-code`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Apply-Worker-Key': config.applyWorkerSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      company: params.company,
      role: params.role,
      applyUrl: params.applyUrl,
      timeoutMs: params.timeoutMs,
      skipPrompt: params.skipPrompt,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log(
      `[telegram] wait-security-code failed (${res.status}): ${body.slice(0, 200)}`,
    );
    return null;
  }

  const data = (await res.json()) as { success?: boolean; code?: string };
  if (!data.success || !data.code) {
    return null;
  }

  console.log(`[telegram] received security code (${data.code.length} chars)`);
  return data.code;
}

export async function notifySecurityCodeRejected(params: {
  userId: string;
  company?: string;
  role?: string;
}): Promise<void> {
  const url = `${config.apiPublicUrl}/api/v1/internal/apply/users/${params.userId}/telegram/notify-rejected`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'X-Apply-Worker-Key': config.applyWorkerSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      company: params.company,
      role: params.role,
    }),
  }).catch(() => undefined);
}
