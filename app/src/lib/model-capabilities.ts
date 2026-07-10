import type {
  AIProviderType,
  ModelCapabilities,
  ModelCapabilitySupport,
  HarnessProfileSettings,
} from '@/types';
import { computeAdaptiveProfile, logAdaptiveProfile } from './harness-profiles';
import { lookupDeclaredModelMetadata, type DeclaredModelMetadata } from '@push/lib/model-metadata';
import { getProviderDisplayName } from '@push/lib/provider-definition';

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
    providers: ['openrouter'],
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
    providers: ['openrouter', 'zen'],
    match: /gemini/i,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      jsonMode: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['ollama', 'nvidia', 'cloudflare'],
    match: /vision|vl\b|llava|bakllava|minicpm-v|moondream|gemma[- ]?3|llama3\.2-vision/i,
    capabilities: {
      visionInput: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['cloudflare'],
    match: /.*/,
    capabilities: {
      streaming: 'supported',
    },
  },
  {
    providers: ['zai'],
    match: /.*/,
    capabilities: {
      toolCalls: 'supported',
      jsonMode: 'supported',
      streaming: 'supported',
    },
  },
  {
    providers: ['fireworks', 'sakana'],
    match: /.*/,
    capabilities: {
      visionInput: 'supported',
      toolCalls: 'supported',
      streaming: 'supported',
    },
  },
  {
    // DeepSeek V4 is OpenAI-compatible with native tool calling, JSON mode, and
    // streaming. Vision is left unverified (the direct API is text-only today).
    providers: ['deepseek'],
    match: /.*/,
    capabilities: {
      toolCalls: 'supported',
      jsonMode: 'supported',
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

function boolSupport(value: boolean | undefined): ModelCapabilitySupport {
  if (value === true) return 'supported';
  if (value === false) return 'unsupported';
  return 'unknown';
}

function declaredCapabilities(meta: DeclaredModelMetadata): ModelCapabilities {
  return {
    // Vision = image input only; declared `attachment` also covers PDF/file
    // input, so PDF-only models must not be reported as image-capable.
    visionInput: boolSupport(meta.inputModalities.includes('image')),
    imageGeneration: boolSupport(meta.outputModalities.includes('image')),
    toolCalls: boolSupport(meta.toolCall),
    jsonMode: boolSupport(meta.structuredOutput),
    streaming: 'supported',
  };
}

export function getModelCapabilities(
  provider: AIProviderType,
  modelId: string | null | undefined,
): ModelCapabilities {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return DEFAULT_MODEL_CAPABILITIES;

  if (provider === 'demo') {
    return mergeCapabilities(DEFAULT_MODEL_CAPABILITIES, {
      visionInput: 'unsupported',
      imageGeneration: 'unsupported',
      toolCalls: 'unsupported',
      jsonMode: 'unsupported',
      streaming: 'unsupported',
    });
  }

  const declared = lookupDeclaredModelMetadata(provider, trimmedModelId);
  if (declared) return declaredCapabilities(declared);

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
    `Provider: ${getProviderDisplayName(provider)}`,
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
// Harness profile resolution — one base profile + behavior-driven adaptation
// ---------------------------------------------------------------------------

/**
 * The single static base every run starts from. The model-name "frontier
 * detector" that once chose `standard` vs `heavy` was removed: it was a
 * drifted regex allowlist (it mislabeled Sonnet 4.x / unknown / the
 * default model as weak), and the only setting it differentiated —
 * `contextResetsEnabled` — is now driven by `computeAdaptiveProfile` from
 * *observed* context-pressure signals instead of a model-name guess.
 */
const BASE_HARNESS_PROFILE: HarnessProfileSettings = {
  profile: 'standard',
  maxCoderRounds: 30,
  contextResetsEnabled: false,
  evaluateAfterCoder: true,
  runTokenBudget: null,
};

/** Resolve harness settings: the base profile, then behavior-driven
 *  adaptation (`computeAdaptiveProfile` — clamps rounds / enables context
 *  resets when the model's observed signals warrant it).
 *
 *  `overrides` carries user-set preferences that aren't model-adaptive — today
 *  the per-run token budget. Passing it here (rather than mutating the result
 *  at each call site) keeps the one field that's a *user choice* folded into
 *  the same struct the kernel reads, so the inline lead, delegated sub-Coder,
 *  and background job all see the same value. Omit on worker call sites that
 *  have no client preference (they inherit the base `null` / the envelope's). */
export function resolveHarnessSettings(
  provider: AIProviderType,
  modelId: string | null | undefined,
  overrides?: { runTokenBudget?: number | null },
): HarnessProfileSettings {
  const adaptiveResult = computeAdaptiveProfile(
    { ...BASE_HARNESS_PROFILE },
    provider,
    modelId ?? undefined,
  );
  logAdaptiveProfile(adaptiveResult, provider, modelId ?? undefined);
  const resolved = adaptiveResult.adaptedProfile;
  if (overrides && overrides.runTokenBudget !== undefined) {
    return { ...resolved, runTokenBudget: overrides.runTokenBudget };
  }
  return resolved;
}
