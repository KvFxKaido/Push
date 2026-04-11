import type {
  AIProviderType,
  ModelCapabilities,
  ModelCapabilitySupport,
  HarnessProfile,
  HarnessProfileSettings,
} from '@/types';
import { computeAdaptiveProfile, logAdaptiveProfile } from './harness-profiles';

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
  {
    providers: ['kilocode'],
    match: /.*/,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
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

function matchesProvider(
  ruleProviders: CapabilityRule['providers'],
  provider: AIProviderType,
): boolean {
  return ruleProviders === 'any' || ruleProviders.includes(provider);
}

export function getModelCapabilities(
  provider: AIProviderType,
  modelId: string | null | undefined,
): ModelCapabilities {
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

function formatCapabilitySupportLabel(support: ModelCapabilitySupport): string {
  if (support === 'supported') return 'supported';
  if (support === 'unsupported') return 'unsupported';
  return 'unverified';
}

function formatProviderLabel(provider: AIProviderType): string {
  switch (provider) {
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'zen':
      return 'OpenCode Zen';
    case 'nvidia':
      return 'Nvidia NIM';
    case 'blackbox':
      return 'Blackbox AI';
    case 'kilocode':
      return 'Kilo Code';
    case 'azure':
      return 'Azure OpenAI';
    case 'bedrock':
      return 'AWS Bedrock';
    case 'vertex':
      return 'Google Vertex';
    case 'demo':
      return 'Demo';
    default:
      return provider;
  }
}

export function buildModelCapabilityAwarenessBlock(
  provider: AIProviderType,
  modelId: string | null | undefined,
  options?: {
    hasImageAttachments?: boolean;
  },
): string {
  const resolvedModel = modelId?.trim() || 'default model';
  const capabilities = getModelCapabilities(provider, resolvedModel);
  const lines = [
    '## Current Model Capability Context',
    `Provider: ${formatProviderLabel(provider)}`,
    `Model: ${resolvedModel}`,
    `Vision / image attachments: ${formatCapabilitySupportLabel(capabilities.visionInput)}`,
    `Native tool calling: ${formatCapabilitySupportLabel(capabilities.toolCalls)}`,
    `Native JSON mode: ${formatCapabilitySupportLabel(capabilities.jsonMode)}`,
    `Image generation: ${formatCapabilitySupportLabel(capabilities.imageGeneration)}`,
    'Rules:',
    '- Push tool use is prompt-engineered. Continue using the JSON tool protocol even when native tool calling or JSON mode are unsupported or unverified.',
    '- Delegated Coder and Explorer runs inherit this same chat-locked provider/model by default. Delegation does not upgrade capabilities.',
    '- If the task depends on a capability that is unsupported or unverified, say so plainly instead of guessing.',
    '- Do not promise image generation here unless Push exposes a matching image-generation tool path.',
  ];

  if (options?.hasImageAttachments) {
    if (capabilities.visionInput === 'supported') {
      lines.push(
        '- The current conversation includes image attachments, and this model can inspect them.',
      );
    } else if (capabilities.visionInput === 'unsupported') {
      lines.push(
        '- The current conversation includes image attachments, but this model cannot inspect them. Explain the limitation instead of delegating and pretending the images were understood.',
      );
    } else {
      lines.push(
        '- The current conversation includes image attachments, but support is unverified. Be explicit if you cannot confidently interpret the images.',
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Harness profile resolution — tier-based scaffolding for agent runs
// ---------------------------------------------------------------------------

const STANDARD_PROFILE_SETTINGS: HarnessProfileSettings = {
  profile: 'standard',
  maxCoderRounds: 30,
  plannerRequired: false,
  contextResetsEnabled: false,
  evaluateAfterCoder: true,
};

const HEAVY_PROFILE_SETTINGS: HarnessProfileSettings = {
  profile: 'heavy',
  maxCoderRounds: 20,
  plannerRequired: true,
  contextResetsEnabled: true,
  evaluateAfterCoder: true,
};

/**
 * Resolve the harness profile for a given provider + model combination.
 * Opus-class and large frontier models get 'standard' (less scaffolding).
 * Everything else gets 'heavy' (more guardrails).
 */
export function getHarnessProfile(
  _provider: AIProviderType,
  modelId: string | null | undefined,
): HarnessProfile {
  const id = modelId?.trim()?.toLowerCase() || '';

  // Opus-class models — capable enough for minimal scaffolding
  if (/opus/i.test(id)) return 'standard';

  // Claude 3.5 Sonnet — proven capable for long-running tasks
  if (/claude-3-5-sonnet|claude-3\.5-sonnet/i.test(id)) return 'standard';

  // GPT-4o and GPT-5.4+ tier
  if (/gpt-4o|gpt-5\.[4-9]|gpt-5\.1\d/i.test(id)) return 'standard';

  // Gemini large Pro / 3.1-pro models
  if (/gemini-3\.1-pro|gemini-3-pro/i.test(id)) return 'standard';

  // Grok large models
  if (/grok-4/i.test(id)) return 'standard';

  // GLM-5 (non-turbo) — large model
  if (/glm-5(?!-turbo)/i.test(id)) return 'standard';

  // Everything else: Sonnet 4.x, Haiku, smaller models, unknown models
  return 'heavy';
}

/** Get the concrete settings for a harness profile tier. */
export function getHarnessProfileSettings(profile: HarnessProfile): HarnessProfileSettings {
  return profile === 'standard' ? { ...STANDARD_PROFILE_SETTINGS } : { ...HEAVY_PROFILE_SETTINGS };
}

/** Convenience: resolve settings directly from provider + model. */
export function resolveHarnessSettings(
  provider: AIProviderType,
  modelId: string | null | undefined,
): HarnessProfileSettings {
  const profile = getHarnessProfile(provider, modelId);
  const settings = getHarnessProfileSettings(profile);
  const adaptiveResult = computeAdaptiveProfile(settings, provider, modelId ?? undefined);
  logAdaptiveProfile(adaptiveResult, provider, modelId ?? undefined);
  return adaptiveResult.adaptedProfile;
}
