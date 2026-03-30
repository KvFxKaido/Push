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

/**
 * Build a correlation object from request ID and trace headers.
 * Used for log correlation across client/worker boundaries.
 */
export function buildCorrelation(
  requestId: string,
  traceId?: string | null,
  spanId?: string | null,
): { requestId: string; traceId?: string; spanId?: string } {
  return {
    requestId,
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}
