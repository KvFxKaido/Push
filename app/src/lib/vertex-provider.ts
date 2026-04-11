export type VertexTransport = 'openapi' | 'anthropic';

export interface VertexModelOption {
  id: string;
  label: string;
  transport: VertexTransport;
  family: 'gemini' | 'claude';
}

export interface ParsedVertexServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface VertexRegionResult {
  ok: true;
  normalized: string;
}

export interface InvalidVertexRegionResult {
  ok: false;
  error: string;
}

export interface VertexServiceAccountResult {
  ok: true;
  parsed: ParsedVertexServiceAccount;
  normalized: string;
}

export interface InvalidVertexServiceAccountResult {
  ok: false;
  error: string;
}

export type VertexRegionValidationResult = VertexRegionResult | InvalidVertexRegionResult;
export type VertexServiceAccountValidationResult =
  | VertexServiceAccountResult
  | InvalidVertexServiceAccountResult;

export const VERTEX_DEFAULT_REGION = 'global';

export const VERTEX_MODEL_OPTIONS: VertexModelOption[] = [
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', transport: 'openapi', family: 'gemini' },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    transport: 'openapi',
    family: 'gemini',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    transport: 'openapi',
    family: 'gemini',
  },
  {
    id: 'claude-sonnet-4-5@20250929',
    label: 'Claude Sonnet 4.5',
    transport: 'anthropic',
    family: 'claude',
  },
  {
    id: 'claude-haiku-4-5@20251001',
    label: 'Claude Haiku 4.5',
    transport: 'anthropic',
    family: 'claude',
  },
  {
    id: 'claude-sonnet-4@20250514',
    label: 'Claude Sonnet 4',
    transport: 'anthropic',
    family: 'claude',
  },
  {
    id: 'claude-opus-4-1@20250805',
    label: 'Claude Opus 4.1',
    transport: 'anthropic',
    family: 'claude',
  },
];

export const VERTEX_DEFAULT_MODEL = VERTEX_MODEL_OPTIONS[0]?.id ?? 'google/gemini-2.5-pro';

const VERTEX_MODEL_OPTION_MAP = new Map(VERTEX_MODEL_OPTIONS.map((model) => [model.id, model]));

function normalizeMultilinePem(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function normalizeVertexRegion(
  rawValue: string | null | undefined,
): VertexRegionValidationResult {
  const value = (rawValue || '').trim();
  if (!value) {
    return { ok: false, error: 'Region is required.' };
  }

  if (value === 'global') {
    return { ok: true, normalized: value };
  }

  if (!/^[a-z]+(?:-[a-z0-9]+)+$/.test(value)) {
    return {
      ok: false,
      error: 'Region must be "global" or a valid Google Cloud location like us-east5.',
    };
  }

  return { ok: true, normalized: value };
}

export function parseVertexServiceAccount(
  rawValue: string | null | undefined,
): VertexServiceAccountValidationResult {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Service account JSON is required.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Service account must be valid JSON.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Service account must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  const projectId = typeof record.project_id === 'string' ? record.project_id.trim() : '';
  const clientEmail = typeof record.client_email === 'string' ? record.client_email.trim() : '';
  const privateKey =
    typeof record.private_key === 'string' ? normalizeMultilinePem(record.private_key) : '';

  if (type !== 'service_account') {
    return { ok: false, error: 'JSON must be a Google service account credential.' };
  }
  if (!projectId) {
    return { ok: false, error: 'Service account JSON is missing "project_id".' };
  }
  if (!clientEmail) {
    return { ok: false, error: 'Service account JSON is missing "client_email".' };
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    return { ok: false, error: 'Service account JSON is missing a valid "private_key".' };
  }

  const normalizedRecord = {
    ...record,
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
  };

  return {
    ok: true,
    parsed: {
      projectId,
      clientEmail,
      privateKey,
    },
    normalized: JSON.stringify(normalizedRecord),
  };
}

export function looksLikeVertexServiceAccount(rawValue: string | null | undefined): boolean {
  return parseVertexServiceAccount(rawValue).ok;
}

export function getVertexModelOption(modelId: string | null | undefined): VertexModelOption | null {
  if (!modelId) return null;
  return VERTEX_MODEL_OPTION_MAP.get(modelId.trim()) ?? null;
}

export function getVertexModelTransport(modelId: string | null | undefined): VertexTransport {
  const option = getVertexModelOption(modelId);
  if (option) return option.transport;

  const normalized = (modelId || '').trim().toLowerCase();
  if (normalized.startsWith('claude-')) return 'anthropic';
  return 'openapi';
}

export function getVertexModelDisplayName(modelId: string | null | undefined): string {
  const option = getVertexModelOption(modelId);
  return option?.label ?? (modelId || '').trim();
}

export function encodeVertexServiceAccountHeader(rawValue: string | null | undefined): string {
  const parsed = parseVertexServiceAccount(rawValue);
  if (!parsed.ok) return '';
  return btoa(parsed.normalized);
}

export function decodeVertexServiceAccountHeader(
  rawValue: string | null | undefined,
): VertexServiceAccountValidationResult {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Missing Vertex service account header.' };
  }

  try {
    return parseVertexServiceAccount(atob(trimmed));
  } catch {
    return { ok: false, error: 'Vertex service account header is not valid base64.' };
  }
}

export function buildVertexOpenApiBaseUrl(projectId: string, region: string): string {
  return `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${region}/endpoints/openapi`;
}

export function buildVertexAnthropicEndpoint(
  projectId: string,
  region: string,
  model: string,
): string {
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${model}:streamRawPredict`;
}
