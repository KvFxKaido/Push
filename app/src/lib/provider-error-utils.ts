import { asRecord } from './utils';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readNestedErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizeWhitespace(value);
    return normalized || null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const directKeys = ['message', 'detail', 'error_description'] as const;
  for (const key of directKeys) {
    const direct = record[key];
    if (typeof direct === 'string') {
      const normalized = normalizeWhitespace(direct);
      if (normalized) return normalized;
    }
  }

  const nestedKeys = ['error', 'innererror', 'inner_error', 'details'] as const;
  for (const key of nestedKeys) {
    const nested = readNestedErrorMessage(record[key]);
    if (nested) return nested;
  }

  return null;
}

export function extractProviderErrorDetail(
  parsed: unknown,
  fallback: string,
  includeTopLevelMessage = false,
): string {
  const record = asRecord(parsed);
  if (!record) return normalizeWhitespace(fallback) || fallback;

  const nestedError = readNestedErrorMessage(record.error);
  if (nestedError) return nestedError;

  if (includeTopLevelMessage) {
    const topLevelMessage = readNestedErrorMessage(record.message);
    if (topLevelMessage) return topLevelMessage;
  }

  return normalizeWhitespace(fallback) || fallback;
}

export function extractProviderErrorDetailFromText(
  bodyText: string,
  fallback = 'empty body',
  includeTopLevelMessage = true,
): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return fallback;

  try {
    return extractProviderErrorDetail(
      JSON.parse(trimmed),
      trimmed.slice(0, 200),
      includeTopLevelMessage,
    );
  } catch {
    return normalizeWhitespace(trimmed.slice(0, 200)) || fallback;
  }
}

/**
 * Extract a clean detail string from an upstream HTTP error body. Mirrors the
 * HTML guard that `createStreamProxyHandler`'s default error path applies, then
 * falls through to {@link extractProviderErrorDetailFromText} for JSON-shaped
 * errors. Use in custom `formatUpstreamError` callbacks so HTML 5xx pages from
 * upstream providers or fronting CDNs (Cloudflare, AI Gateway) don't leak
 * raw markup into user-facing messages.
 */
export function extractProviderHttpErrorDetail(status: number, bodyText: string): string {
  if (/<\s*html[\s>]/i.test(bodyText) || /<\s*!doctype/i.test(bodyText)) {
    return `HTTP ${status} (the server returned an HTML error page instead of JSON)`;
  }
  return extractProviderErrorDetailFromText(bodyText);
}
