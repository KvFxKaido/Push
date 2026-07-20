/**
 * Surface-neutral provider capability resolution.
 *
 * The resolver owns the decision algorithm. Web, CLI, and future shells only
 * supply raw model metadata: the web adapter can read live/cached catalogs,
 * while the CLI adapter can project its curated model lists into the same
 * metadata shape. Credential discovery and catalog caching never enter here.
 */

import { anthropicModelSupportsNativeStructuredOutput } from './anthropic-structured-output.js';
import {
  DEFAULT_PUSH_CAPABILITY_PROFILE,
  type PushCapabilityProfile,
  type PushContextTier,
  type PushOpenAIWire,
  type PushStructuredOutputMode,
} from './capabilities.js';
import {
  looksLikeOpenAIToolCallingModel,
  OLLAMA_NATIVE_TOOL_CALLING_DENYLIST,
} from './native-tool-gate.js';
import {
  providerCarriesReasoningBlocksByDefault,
  providerConsumesContentBlocksByDefault,
} from './provider-definition.js';
import { getZenGoTransport } from './zen-go.js';

export const MIN_PUSH_CONTEXT_TOKENS = 64_000;

/** Raw evidence supplied by a shell-local metadata source. */
export interface PushModelCapabilityMetadata {
  /** Undefined means the source has no evidence; false means a known denial. */
  toolCall?: boolean;
  /** Whether the model accepts image input. */
  vision?: boolean;
  /** Whether the route/model can enforce a native JSON-schema constraint. */
  structuredOutput?: boolean;
  /** Discoverable OpenAI-family wire support, when a provider catalog exposes it. */
  openaiWire?: PushOpenAIWire;
  /** Provider-advertised context window. Zero/undefined means unknown. */
  contextLimit?: number;
}

export type PushCapabilityMetadataLookup = (
  provider: string,
  _modelId: string,
) => PushModelCapabilityMetadata | null | undefined;

export interface PushCapabilityProfileOptions {
  /** Request body contract for this route. `neutral` routes consume contentBlocks. */
  requestWire?: 'neutral' | 'openai';
}

const METADATA_NATIVE_TOOL_PROVIDERS: ReadonlySet<string> = new Set([
  'openrouter',
  'zai',
  'kimi',
  'huggingface',
  'zen',
  'fireworks',
  'sakana',
  'xai',
  'google',
  'ollama',
  'anthropic',
]);

/**
 * Providers whose route can honor Push's neutral `ResponseFormatSpec`.
 * Membership only governs *whether the wire can honor the constraint* —
 * attachment is still gated per model below, so a provider never attaches a
 * constraint its routed endpoint would silently drop. Gemini/Ollama-style
 * routes with absent or unconfirmed support are omitted so the prompt-only
 * `parseStructured` fallback stays in charge. google/xai deliberately reuse
 * the native-tool gate so the two capability columns can't drift (the #1169
 * cross-column failure mode).
 */
const STRUCTURED_OUTPUT_PROVIDERS: ReadonlySet<string> = new Set([
  'openrouter',
  'openai',
  'xai',
  'fireworks',
  'sakana',
  'zen',
  'cloudflare',
  'anthropic',
  'google',
]);

const RESPONSES_NATIVE_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'xai',
  'sakana',
  'fireworks',
]);

function resolveOpenAIWire(
  provider: string,
  _modelId: string,
  metadata: PushModelCapabilityMetadata,
): PushOpenAIWire {
  if (RESPONSES_NATIVE_PROVIDERS.has(provider)) return 'responses';
  if (provider !== 'openrouter') return 'chat-completions';
  // OpenRouter's `/responses` beta serves essentially every live model (verified
  // by a full-roster probe), and the request path runs it responses-first with a
  // chat fallback (`streamResponsesWithChatFallback`) — a beta hiccup on any model
  // degrades to Chat Completions rather than failing the turn. So default every
  // other route to responses; discoverable metadata can still force chat if a
  // catalog ever advertises the split. (Replaces the hand-curated seed allowlist,
  // which the probe showed was capability-obsolete.)
  return metadata.openaiWire ?? 'responses';
}

function isCloudflareKimiOrGlm(modelId: string): boolean {
  const model = modelId.toLowerCase();
  return model.includes('kimi') || model.includes('moonshot') || model.includes('glm');
}

function modelSupportsNativeToolCalling(
  provider: string,
  modelId: string,
  metadata: PushModelCapabilityMetadata,
): boolean {
  if (provider === 'cloudflare') {
    return metadata.toolCall ?? isCloudflareKimiOrGlm(modelId);
  }
  if (provider === 'openai') return looksLikeOpenAIToolCallingModel(modelId);
  if (provider === 'ollama') {
    return metadata.toolCall === true && !OLLAMA_NATIVE_TOOL_CALLING_DENYLIST.has(modelId);
  }
  if (METADATA_NATIVE_TOOL_PROVIDERS.has(provider)) return metadata.toolCall === true;
  return false;
}

function resolveStructuredOutputMode(
  provider: string,
  modelId: string,
  metadata: PushModelCapabilityMetadata,
  nativeToolCalling: boolean,
): PushStructuredOutputMode {
  if (!STRUCTURED_OUTPUT_PROVIDERS.has(provider)) return 'none';
  if (provider === 'cloudflare') {
    return (metadata.structuredOutput ?? isCloudflareKimiOrGlm(modelId)) ? 'strict' : 'none';
  }
  if (provider === 'anthropic') {
    return anthropicModelSupportsNativeStructuredOutput(modelId) ? 'strict' : 'best-effort';
  }
  if (provider === 'zen' && getZenGoTransport(modelId) === 'anthropic') {
    return anthropicModelSupportsNativeStructuredOutput(modelId) ? 'strict' : 'best-effort';
  }
  if (provider === 'google' || provider === 'xai') {
    return nativeToolCalling ? 'strict' : 'none';
  }
  return metadata.structuredOutput === true ? 'strict' : 'none';
}

function resolveContextTier(contextLimit: number | undefined): PushContextTier {
  const limit = contextLimit ?? 0;
  if (limit >= 200_000) return 'large';
  if (limit >= MIN_PUSH_CONTEXT_TOKENS || limit === 0) return 'medium';
  return 'small';
}

function routeConsumesContentBlocks(
  provider: string,
  options: PushCapabilityProfileOptions | undefined,
): boolean {
  if (options?.requestWire === 'neutral') return true;
  if (options?.requestWire === 'openai') return false;
  return providerConsumesContentBlocksByDefault(provider);
}

function routeCarriesReasoningBlocks(provider: string, modelId: string): boolean {
  if (providerCarriesReasoningBlocksByDefault(provider)) return true;
  return provider === 'zen' && getZenGoTransport(modelId) === 'anthropic';
}

function modelSupportsMultimodal(
  provider: string,
  modelId: string,
  metadata: PushModelCapabilityMetadata,
): boolean {
  if (metadata.vision === true) return true;
  if (provider === 'anthropic' || provider === 'google') return true;
  return /(?:gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|vl\b|llava|bakllava)/i.test(modelId);
}

/**
 * Resolve the complete Push model-wire profile using shell-provided metadata.
 * The lookup is intentionally synchronous because both current sources are
 * already materialized before send time (browser cache or CLI curated catalog).
 */
export function resolvePushCapabilityProfile(
  provider: string,
  modelId: string | undefined,
  lookupMetadata: PushCapabilityMetadataLookup = () => undefined,
  options?: PushCapabilityProfileOptions,
): PushCapabilityProfile {
  const model = modelId?.trim();
  const contentBlocks = routeConsumesContentBlocks(provider, options);
  if (!model) {
    return {
      ...DEFAULT_PUSH_CAPABILITY_PROFILE,
      openaiWire: resolveOpenAIWire(provider, '', {}),
      toolCalling: 'none',
      contentBlocks,
      reasoningBlocks: false,
      context: 'small',
    };
  }

  const metadata = lookupMetadata(provider, model) ?? {};
  const nativeToolCalling = modelSupportsNativeToolCalling(provider, model, metadata);
  return {
    toolCalling: nativeToolCalling ? 'native' : 'json-text',
    streamingTools: nativeToolCalling,
    multimodal: modelSupportsMultimodal(provider, model, metadata),
    structuredOutput: resolveStructuredOutputMode(provider, model, metadata, nativeToolCalling),
    openaiWire: resolveOpenAIWire(provider, model, metadata),
    contentBlocks,
    reasoningBlocks: routeCarriesReasoningBlocks(provider, model),
    context: resolveContextTier(metadata.contextLimit),
  };
}
