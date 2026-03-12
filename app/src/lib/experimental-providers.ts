export const EXPERIMENTAL_PROVIDER_TYPES = ['azure', 'bedrock', 'vertex'] as const;

export type ExperimentalProviderType = (typeof EXPERIMENTAL_PROVIDER_TYPES)[number];
export const MAX_EXPERIMENTAL_DEPLOYMENTS = 3;

export interface ExperimentalDeployment {
  id: string;
  model: string;
  baseUrl?: string;
}

export interface ExperimentalProviderDescriptor {
  type: ExperimentalProviderType;
  label: string;
  shortLabel: string;
  defaultModel: string;
  baseUrlPlaceholder: string;
  modelPlaceholder: string;
  helperText: string;
}

export interface NormalizedExperimentalBaseUrl {
  ok: true;
  normalized: string;
}

export interface InvalidExperimentalBaseUrl {
  ok: false;
  error: string;
}

export type ExperimentalBaseUrlResult =
  | NormalizedExperimentalBaseUrl
  | InvalidExperimentalBaseUrl;

export const EXPERIMENTAL_PROVIDER_DESCRIPTORS: Record<ExperimentalProviderType, ExperimentalProviderDescriptor> = {
  azure: {
    type: 'azure',
    label: 'Azure OpenAI',
    shortLabel: 'Azure',
    defaultModel: 'gpt-4.1',
    baseUrlPlaceholder: 'https://your-resource.services.ai.azure.com/api/projects/PROJECT',
    modelPlaceholder: 'Deployment or model name',
    helperText: 'Direct Azure connector. Accepts classic Azure OpenAI /openai/v1 URLs and Azure AI Foundry project URLs.',
  },
  bedrock: {
    type: 'bedrock',
    label: 'AWS Bedrock',
    shortLabel: 'Bedrock',
    defaultModel: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    modelPlaceholder: 'Bedrock model id',
    helperText: 'Direct Bedrock OpenAI-compatible endpoint. Use a region-specific bedrock-runtime host.',
  },
  vertex: {
    type: 'vertex',
    label: 'Google Vertex',
    shortLabel: 'Vertex',
    defaultModel: 'google/gemini-2.5-pro',
    baseUrlPlaceholder: 'https://aiplatform.googleapis.com/v1beta1/projects/PROJECT/locations/global/endpoints/openapi',
    modelPlaceholder: 'Vertex model id',
    helperText: 'Direct Vertex AI OpenAI-compatible endpoint. Use the OpenAPI endpoint base URL for your project/location.',
  },
};

export function isExperimentalProviderType(value: string): value is ExperimentalProviderType {
  return EXPERIMENTAL_PROVIDER_TYPES.includes(value as ExperimentalProviderType);
}

export function getExperimentalProviderDescriptor(provider: ExperimentalProviderType): ExperimentalProviderDescriptor {
  return EXPERIMENTAL_PROVIDER_DESCRIPTORS[provider];
}

function hashDeploymentKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export function buildExperimentalDeploymentId(model: string): string {
  return `dep_${hashDeploymentKey(model)}`;
}

function deploymentFingerprint(model: string): string {
  return model;
}

function stripKnownSuffixes(pathname: string): string {
  if (pathname.endsWith('/chat/completions')) {
    return pathname.slice(0, -'/chat/completions'.length);
  }
  if (pathname.endsWith('/models')) {
    return pathname.slice(0, -'/models'.length);
  }
  return pathname;
}

function normalizeAzurePath(pathname: string): ExperimentalBaseUrlResult {
  if (pathname === '/openai/v1') {
    return { ok: true, normalized: pathname };
  }

  const foundryProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/openai\/v1)?$/i);
  if (foundryProjectMatch) {
    return {
      ok: true,
      normalized: `/api/projects/${foundryProjectMatch[1]}/openai/v1`,
    };
  }

  return {
    ok: false,
    error: 'Azure Foundry URLs must look like /api/projects/<project> (Push adds /openai/v1) or end at /openai/v1.',
  };
}

export function normalizeExperimentalBaseUrl(
  provider: ExperimentalProviderType,
  rawValue: string | null | undefined,
): ExperimentalBaseUrlResult {
  const value = (rawValue || '').trim();
  if (!value) {
    return { ok: false, error: 'Base URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Base URL must be a valid https URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must use https.' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'Base URL must not include query params or fragments.' };
  }

  let pathname = stripKnownSuffixes(parsed.pathname.replace(/\/+$/, ''));

  if (!pathname) pathname = '/';

  switch (provider) {
    case 'azure': {
      const isClassicAzureHost = parsed.hostname.endsWith('.openai.azure.com');
      const isFoundryAzureHost = parsed.hostname.endsWith('.services.ai.azure.com');
      if (!isClassicAzureHost && !isFoundryAzureHost) {
        return {
          ok: false,
          error: 'Azure URLs must use either a <resource>.openai.azure.com or <resource>.services.ai.azure.com host.',
        };
      }

      const normalizedAzurePath = normalizeAzurePath(pathname);
      if (!normalizedAzurePath.ok) {
        return normalizedAzurePath;
      }

      if (isClassicAzureHost && normalizedAzurePath.normalized !== '/openai/v1') {
        return {
          ok: false,
          error: 'Classic Azure OpenAI resource URLs must end at /openai/v1.',
        };
      }

      pathname = normalizedAzurePath.normalized;
      break;
    }
    case 'bedrock': {
      if (!/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(parsed.hostname)) {
        return { ok: false, error: 'Bedrock URLs must use a bedrock-runtime.<region>.amazonaws.com host.' };
      }
      if (pathname !== '/openai/v1') {
        return { ok: false, error: 'Bedrock base URL must end at /openai/v1.' };
      }
      break;
    }
    case 'vertex': {
      if (!/^[a-z0-9-]+-aiplatform\.googleapis\.com$/i.test(parsed.hostname)) {
        const isGlobalHost = parsed.hostname === 'aiplatform.googleapis.com';
        if (!isGlobalHost) {
          return { ok: false, error: 'Vertex URLs must use aiplatform.googleapis.com or a <location>-aiplatform.googleapis.com host.' };
        }
      }
      if (!/^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/endpoints\/openapi$/i.test(pathname)) {
        return {
          ok: false,
          error: 'Vertex base URL must look like /v1beta1/projects/<project>/locations/<location>/endpoints/openapi.',
        };
      }
      break;
    }
  }

  return { ok: true, normalized: `${parsed.origin}${pathname}` };
}

export function normalizeExperimentalDeployment(
  provider: ExperimentalProviderType,
  raw: {
    id?: string | null;
    baseUrl?: string | null;
    model?: string | null;
  },
): ExperimentalDeployment | null {
  const model = (raw.model || '').trim();
  if (!model) return null;

  const normalizedBaseUrl = raw.baseUrl
    ? normalizeExperimentalBaseUrl(provider, raw.baseUrl)
    : null;

  return {
    id: (raw.id || '').trim() || buildExperimentalDeploymentId(model),
    model,
    ...(normalizedBaseUrl?.ok ? { baseUrl: normalizedBaseUrl.normalized } : {}),
  };
}

export function parseStoredExperimentalDeployments(
  provider: ExperimentalProviderType,
  rawValue: string | null | undefined,
): ExperimentalDeployment[] {
  if (!rawValue) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const deployments: ExperimentalDeployment[] = [];

  for (const item of parsed) {
    const normalized = normalizeExperimentalDeployment(
      provider,
      typeof item === 'object' && item
        ? item as { id?: string | null; baseUrl?: string | null; model?: string | null }
        : {},
    );
    if (!normalized) continue;

    const fingerprint = deploymentFingerprint(normalized.model);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deployments.push(normalized);

    if (deployments.length >= MAX_EXPERIMENTAL_DEPLOYMENTS) {
      break;
    }
  }

  return deployments;
}

export function buildExperimentalProxyHeaders(
  provider: ExperimentalProviderType,
  baseUrl: string,
): Record<string, string> {
  const normalized = normalizeExperimentalBaseUrl(provider, baseUrl);
  return normalized.ok
    ? {
        'X-Push-Upstream-Base': normalized.normalized,
      }
    : {};
}
