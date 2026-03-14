import type { AIProviderType, ModelCapabilities, ModelCapabilitySupport } from '@/types';

type CapabilityRule = {
  providers: AIProviderType[] | 'any';
  match: RegExp;
  capabilities: Partial<ModelCapabilities>;
};

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  visionInput: 'unknown',
  imageGeneration: 'unknown',
  toolCalls: 'unknown',
  jsonMode: 'unknown',
  streaming: 'unknown',
};

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    providers: ['demo'],
    match: /.*/,
    capabilities: {
      visionInput: 'unsupported',
      imageGeneration: 'unsupported',
      toolCalls: 'unsupported',
      jsonMode: 'unsupported',
      streaming: 'unsupported',
    },
  },
  {
    providers: 'any',
    match: /gpt-image-1|imagen/i,
    capabilities: {
      visionInput: 'supported',
      imageGeneration: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['openrouter', 'azure'],
    match: /gpt-4o|gpt-4\.1|gpt-4\.5/i,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      jsonMode: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['openrouter'],
    match: /anthropic\/claude/i,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['bedrock', 'vertex'],
    match: /claude/i,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['openrouter', 'vertex', 'zen'],
    match: /gemini/i,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      jsonMode: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['ollama', 'nvidia'],
    match: /vision|vl\b|llava|bakllava|minicpm-v|moondream|gemma3|llama3\.2-vision/i,
    capabilities: {
      visionInput: 'supported',
      streaming: 'supported',
    },
  },
];

function mergeCapabilities(
  base: ModelCapabilities,
  override: Partial<ModelCapabilities>,
): ModelCapabilities {
  return {
    visionInput: override.visionInput ?? base.visionInput,
    imageGeneration: override.imageGeneration ?? base.imageGeneration,
    toolCalls: override.toolCalls ?? base.toolCalls,
    jsonMode: override.jsonMode ?? base.jsonMode,
    streaming: override.streaming ?? base.streaming,
  };
}

function matchesProvider(ruleProviders: CapabilityRule['providers'], provider: AIProviderType): boolean {
  return ruleProviders === 'any' || ruleProviders.includes(provider);
}

export function getModelCapabilities(provider: AIProviderType, modelId: string | null | undefined): ModelCapabilities {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return DEFAULT_MODEL_CAPABILITIES;

  let capabilities = DEFAULT_MODEL_CAPABILITIES;
  for (const rule of CAPABILITY_RULES) {
    if (!matchesProvider(rule.providers, provider)) continue;
    if (!rule.match.test(trimmedModelId)) continue;
    capabilities = mergeCapabilities(capabilities, rule.capabilities);
  }
  return capabilities;
}

export function getModelCapabilitySupport(
  provider: AIProviderType,
  modelId: string | null | undefined,
  capability: keyof ModelCapabilities,
): ModelCapabilitySupport {
  return getModelCapabilities(provider, modelId)[capability];
}

export function getVisionCapabilityNotice(
  provider: AIProviderType,
  modelId: string | null | undefined,
): {
  support: ModelCapabilitySupport;
  text: string;
} {
  const trimmedModelId = modelId?.trim() || 'this model';
  const support = getModelCapabilitySupport(provider, trimmedModelId, 'visionInput');

  if (support === 'supported') {
    return {
      support,
      text: `${trimmedModelId} can read image attachments.`,
    };
  }

  if (support === 'unsupported') {
    return {
      support,
      text: `${trimmedModelId} cannot read image attachments yet.`,
    };
  }

  return {
    support,
    text: `Image support for ${trimmedModelId} is not confirmed yet.`,
  };
}
