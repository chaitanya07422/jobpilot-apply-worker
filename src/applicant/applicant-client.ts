import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config';

export type ApplicantContext = {
  userId: string;
  name: string;
  email: string;
  firstName: string;
  lastName: string;
  resumeId: string;
  resumeFileName: string;
  resumeMimeType: string;
  answers: Record<string, string | string[]>;
  phoneCountry?: string;
  telegramChatId?: string;
  telegramConnected?: boolean;
};

function workerHeaders(): Record<string, string> {
  return {
    'X-Apply-Worker-Key': config.applyWorkerSecret,
  };
}

export async function fetchApplicantContext(
  userId: string,
  jobId: string,
): Promise<ApplicantContext> {
  const params = new URLSearchParams({ jobId });
  const url = `${config.apiPublicUrl}/api/v1/internal/apply/users/${userId}/context?${params}`;
  const res = await fetch(url, { headers: workerHeaders() });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Applicant context failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as ApplicantContext;
  return {
    ...data,
    answers: data.answers ?? {},
  };
}

export async function downloadResumeToTempFile(
  userId: string,
  fileName: string,
): Promise<string> {
  const url = `${config.apiPublicUrl}/api/v1/internal/apply/users/${userId}/resume`;
  const res = await fetch(url, { headers: workerHeaders() });

  if (!res.ok) {
    throw new Error(`Resume download failed (${res.status})`);
  }

  const dir = join(tmpdir(), 'jobpilot-apply');
  await mkdir(dir, { recursive: true });
  const safeName = fileName.replace(/[^\w.-]+/g, '_') || 'resume.pdf';
  const path = join(dir, `${userId}-${Date.now()}-${safeName}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buffer);
  return path;
}

export type ReportedFieldPayload = {
  key: string;
  label: string;
  type: string;
  required: true;
  options?: { value: string; label: string }[];
};

export async function reportMissingFields(params: {
  applyJobId: string;
  userId: string;
  jobId: string;
  fields: ReportedFieldPayload[];
}): Promise<void> {
  const url = `${config.apiPublicUrl}/api/v1/internal/apply/jobs/${params.jobId}/missing-fields`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...workerHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      applyJobId: params.applyJobId,
      userId: params.userId,
      fields: params.fields,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Report missing fields failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
}

export async function removeTempFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
