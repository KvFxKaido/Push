export const REQUEST_ID_HEADER = 'X-Push-Request-Id';

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function normalizeIncomingRequestId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return SAFE_REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function createRequestId(prefix: string = 'req'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 12) || 'req';
  return `${safePrefix}_${crypto.randomUUID()}`;
}

export function getOrCreateRequestId(
  incomingValue: string | null | undefined,
  prefix: string = 'req',
): string {
  return normalizeIncomingRequestId(incomingValue) ?? createRequestId(prefix);
}
