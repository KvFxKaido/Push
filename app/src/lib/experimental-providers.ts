export const EXPERIMENTAL_PROVIDER_TYPES = ['azure', 'bedrock', 'vertex'] as const;

export type ExperimentalProviderType = (typeof EXPERIMENTAL_PROVIDER_TYPES)[number];

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
    baseUrlPlaceholder: 'https://your-resource.openai.azure.com/openai/v1',
    modelPlaceholder: 'Deployment or model name',
    helperText: 'Direct Azure OpenAI deployment. Uses the official OpenAI-compatible /openai/v1 base URL.',
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
    baseUrlPlaceholder: 'https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-central1/endpoints/openapi',
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

function stripKnownSuffixes(pathname: string): string {
  if (pathname.endsWith('/chat/completions')) {
    return pathname.slice(0, -'/chat/completions'.length);
  }
  if (pathname.endsWith('/models')) {
    return pathname.slice(0, -'/models'.length);
  }
  return pathname;
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
      if (!parsed.hostname.endsWith('.openai.azure.com')) {
        return { ok: false, error: 'Azure OpenAI URLs must end with .openai.azure.com.' };
      }
      if (pathname !== '/openai/v1') {
        return { ok: false, error: 'Azure OpenAI base URL must end at /openai/v1.' };
      }
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
        return { ok: false, error: 'Vertex URLs must use a <location>-aiplatform.googleapis.com host.' };
      }
      if (!/^\/v1\/projects\/[^/]+\/locations\/[^/]+\/endpoints\/openapi$/i.test(pathname)) {
        return {
          ok: false,
          error: 'Vertex base URL must look like /v1/projects/<project>/locations/<location>/endpoints/openapi.',
        };
      }
      break;
    }
  }

  return { ok: true, normalized: `${parsed.origin}${pathname}` };
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
