import { asRecord } from './utils';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
    return extractProviderErrorDetail(JSON.parse(trimmed), trimmed.slice(0, 200), includeTopLevelMessage);
  } catch {
    return normalizeWhitespace(trimmed.slice(0, 200)) || fallback;
  }
}

function hasSignal(detail: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => detail.includes(candidate));
}

function buildDetailSuffix(detail: string): string {
  const normalized = normalizeWhitespace(detail);
  if (!normalized || normalized === 'empty body') return '';
  return ` Upstream said: ${truncate(normalized)}.`;
}

export function formatExperimentalProviderHttpError(
  providerLabel: string,
  status: number,
  bodyText: string,
): string {
  const detail = extractProviderErrorDetailFromText(bodyText);
  const lower = detail.toLowerCase();

  const quotaSignals = [
    'quota',
    'rate limit',
    'rate-limit',
    'rate_limited',
    'rate_limit',
    'too many requests',
    'insufficient_quota',
    'requests per minute',
    'requests/min',
    'tokens per minute',
    'tokens/min',
    'tpm',
    'rpm',
    'capacity',
    'throttle',
    'throttled',
  ] as const;

  const missingSignals = [
    'deployment',
    'model',
    'not found',
    'does not exist',
    'no such',
    'unknown deployment',
    'unknown model',
  ] as const;

  if (status === 429 || hasSignal(lower, quotaSignals)) {
    return `${providerLabel} is rate limited or out of quota. Check quota, TPM/RPM limits, and billing for this deployment, then retry.${buildDetailSuffix(detail)}`;
  }

  if (status === 401 || status === 403) {
    return `${providerLabel} rejected the request. Check the API key, deployment permissions, and endpoint.${buildDetailSuffix(detail)}`;
  }

  if (status === 404 || (status === 400 && hasSignal(lower, missingSignals))) {
    return `${providerLabel} deployment or model was not found. Check the configured deployment/model name and base URL.${buildDetailSuffix(detail)}`;
  }

  if (status === 400) {
    return `${providerLabel} rejected the request. Check the configured deployment/model and request settings.${buildDetailSuffix(detail)}`;
  }

  if (status >= 500) {
    return `${providerLabel} is unavailable or overloaded right now. Retry in a moment.${buildDetailSuffix(detail)}`;
  }

  return `${providerLabel} API error ${status}: ${truncate(detail)}`;
}

export function formatVertexProviderHttpError(
  status: number,
  bodyText: string,
  transport: 'openapi' | 'anthropic',
): string {
  const detail = extractProviderErrorDetailFromText(bodyText);
  const lower = detail.toLowerCase();

  if (status === 429 || lower.includes('quota') || lower.includes('rate') || lower.includes('throttle')) {
    return `Google Vertex is rate limited or out of quota. Check Vertex quotas, region capacity, and billing.${buildDetailSuffix(detail)}`;
  }

  if (status === 401) {
    return `Google Vertex rejected the request. Check the saved service account credentials.${buildDetailSuffix(detail)}`;
  }

  if (status === 403) {
    return `Google Vertex denied access. Check that the service account has Vertex AI permissions and that this model is enabled for the selected region.${buildDetailSuffix(detail)}`;
  }

  if (status === 404) {
    return transport === 'anthropic'
      ? `Claude on Vertex was not found in this region. Check the Claude model id, region, and partner-model access.${buildDetailSuffix(detail)}`
      : `Gemini on Vertex was not found in this region. Check the model id and region.${buildDetailSuffix(detail)}`;
  }

  if (status === 400) {
    return transport === 'anthropic'
      ? `Claude on Vertex rejected the request. Check the model id and partner-model availability.${buildDetailSuffix(detail)}`
      : `Google Vertex rejected the request. Check the selected Gemini model and region.${buildDetailSuffix(detail)}`;
  }

  if (status >= 500) {
    return `Google Vertex is unavailable or overloaded right now. Retry in a moment.${buildDetailSuffix(detail)}`;
  }

  return `Google Vertex API error ${status}: ${truncate(detail)}`;
}
