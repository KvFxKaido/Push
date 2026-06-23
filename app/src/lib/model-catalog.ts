import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getBlackboxKey } from '@/hooks/useBlackboxConfig';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { getOpenAdapterKey } from '@/hooks/useOpenAdapterConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { safeStorageGet, safeStorageSet } from './safe-storage';
import {
  ANTHROPIC_MODELS,
  CLOUDFLARE_MODELS,
  BLACKBOX_MODELS,
  compareProviderModelIds,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  KILOCODE_MODELS,
  NVIDIA_MODELS,
  OPENADAPTER_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  PROVIDER_URLS,
  ZEN_GO_MODELS,
  ZEN_MODELS,
} from './providers';
import { getZenGoTransport } from './zen-go';
import { asRecord } from './utils';

const MODELS_FETCH_TIMEOUT_MS = 12_000;
const MODELS_DEV_OPENROUTER_URL = 'https://models.dev/api.json';
const MODELS_DEV_OPENROUTER_CACHE_KEY = 'push:models-dev:openrouter-models';
const MODELS_DEV_NVIDIA_CACHE_KEY = 'push:models-dev:nvidia-models';
const MODELS_DEV_OLLAMA_CACHE_KEY = 'push:models-dev:ollama-cloud-models';
const MODELS_DEV_OPENCODE_CACHE_KEY = 'push:models-dev:opencode-models';
const MODELS_DEV_GLOBAL_PROVIDER_CACHE_KEY = 'push:models-dev:all-provider-models';
const MODELS_DEV_OPENROUTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NVIDIA_MAX_CURATED_MODELS = 32;
const OLLAMA_MAX_CURATED_MODELS = 40;
const OPENCODE_MAX_CURATED_MODELS = 48;
export const MIN_CONTEXT_TOKENS = 64000;
const BLACKBOX_MIN_PARAMETER_BILLIONS = 16;
// Use the shared curated list as the single source of truth for priority ordering.
// To add a new OpenRouter model, update OPENROUTER_MODELS in lib/provider-models.ts.
const OPENROUTER_PRIORITY_MODELS: readonly string[] = OPENROUTER_MODELS;
const NVIDIA_PRIORITY_MODELS: readonly string[] = NVIDIA_MODELS;
const OLLAMA_PRIORITY_MODELS = [
  'gemini-3-flash-preview',
  'glm-5',
  'qwen3-coder-next',
  'qwen3-coder:480b',
  'kimi-k2.5',
  'deepseek-v3.2',
  'devstral-2:123b',
  'qwen3-vl:235b-instruct',
  'gemma3:27b',
  'nemotron-3-super',
  'minimax-m2.5',
] as const;
const OPENCODE_PRIORITY_MODELS = [
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'qwen3-coder',
  'kimi-k2.5',
  'glm-5',
  'openai/gpt-5.1-codex-mini',
] as const;
const IMAGE_GENERATION_MODEL_FAMILY_REGEX =
  /nanobanana|(?:^|\/)gpt-image(?:$|[-./:_])|(?:^|\/)imagen(?:$|[-./:_])|(?:^|\/)seedream(?:$|[-./:_])|(?:^|\/)recraft(?:$|[-./:_])|(?:^|\/)(?:black-forest-labs\/)?flux(?:$|[-./:_])/i;

export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength: number;
  isModerated: boolean;
}

export interface ModelsDevOpenRouterMetadata {
  id: string;
  /**
   * Optional attachment flag. OpenRouter's catalog does not report this, but
   * the unified models.dev schema does — we allow the field here so a shared
   * metadata shape (and tests that fixture the unified shape) stays assignable
   * to this narrower type.
   */
  attachment?: boolean;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  inputModalities: string[];
  outputModalities: string[];
  contextLimit: number;
}

interface ModelsDevProviderCachePayload<TModel> {
  fetchedAt: number;
  models: Record<string, TModel>;
}

interface ModelsDevProviderMetadata {
  id: string;
  attachment: boolean;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  inputModalities: string[];
  outputModalities: string[];
  contextLimit: number;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOpenRouterModalityString(value: unknown): {
  inputModalities: string[];
  outputModalities: string[];
} {
  if (typeof value !== 'string' || !value.includes('->')) {
    return { inputModalities: [], outputModalities: [] };
  }

  const [input, output] = value.split('->', 2);
  const parseSide = (part: string) =>
    part
      .split('+')
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    inputModalities: parseSide(input),
    outputModalities: parseSide(output),
  };
}

function readCachedModelsDevOpenRouterMetadata(): Record<
  string,
  ModelsDevOpenRouterMetadata
> | null {
  return readCachedModelsDevMetadata<ModelsDevOpenRouterMetadata>(MODELS_DEV_OPENROUTER_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// In-memory metadata cache (avoids repeated localStorage reads + JSON.parse)
// ---------------------------------------------------------------------------

interface MetadataMemCacheEntry {
  fetchedAt: number;
  models: Record<string, unknown>;
}

// Module-level cache: keyed by storage key, value is the parsed payload or null.
// Populated on first read; invalidated/updated on every write.
const metadataMemCache = new Map<string, MetadataMemCacheEntry | null>();

// ---------------------------------------------------------------------------
// Reasoning effort preference (per-provider, localStorage)
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';
const REASONING_EFFORT_KEY_PREFIX = 'push:reasoning-effort:';
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';
const REASONING_EFFORT_CYCLE: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export function getReasoningEffort(provider: string): ReasoningEffort {
  const raw = safeStorageGet(`${REASONING_EFFORT_KEY_PREFIX}${provider}`);
  if (raw && REASONING_EFFORT_CYCLE.includes(raw as ReasoningEffort)) return raw as ReasoningEffort;
  return DEFAULT_REASONING_EFFORT;
}

export function setReasoningEffort(provider: string, effort: ReasoningEffort): void {
  safeStorageSet(`${REASONING_EFFORT_KEY_PREFIX}${provider}`, effort);
}

export function cycleReasoningEffort(provider: string): ReasoningEffort {
  const current = getReasoningEffort(provider);
  const idx = REASONING_EFFORT_CYCLE.indexOf(current);
  const next = REASONING_EFFORT_CYCLE[(idx + 1) % REASONING_EFFORT_CYCLE.length];
  setReasoningEffort(provider, next);
  return next;
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  low: 'Lo',
  medium: 'Med',
  high: 'Hi',
};

// ---------------------------------------------------------------------------
// Model capabilities
// ---------------------------------------------------------------------------

/** Model capabilities resolved from cached models.dev metadata. */
export interface ResolvedModelCapabilities {
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  imageGen: boolean;
  /** Honors OpenAI-style `response_format: json_schema` (native structured
   *  outputs). Resolved from the model's `structured_outputs` support. */
  structuredOutput: boolean;
  contextLimit: number;
}

const EMPTY_CAPABILITIES: ResolvedModelCapabilities = {
  reasoning: false,
  toolCall: false,
  vision: false,
  imageGen: false,
  structuredOutput: false,
  contextLimit: 0,
};

function resolveFromOpenRouterMetadata(
  meta: ModelsDevOpenRouterMetadata,
): ResolvedModelCapabilities {
  return {
    reasoning: meta.reasoning,
    toolCall: meta.toolCall,
    vision: meta.inputModalities.includes('image'),
    imageGen: meta.outputModalities.includes('image'),
    structuredOutput: meta.structuredOutput,
    contextLimit: meta.contextLimit,
  };
}

function resolveFromProviderMetadata(meta: ModelsDevProviderMetadata): ResolvedModelCapabilities {
  return {
    reasoning: meta.reasoning,
    toolCall: meta.toolCall,
    vision: meta.inputModalities.includes('image') || meta.attachment,
    imageGen: meta.outputModalities.includes('image'),
    structuredOutput: meta.structuredOutput,
    contextLimit: meta.contextLimit,
  };
}

/**
 * Look up cached model capabilities from models.dev metadata.
 * Works for any provider — checks OpenRouter, Ollama, Nvidia, OpenCode, and
 * Blackbox-compatible routed IDs against cached metadata.
 */
export function getModelCapabilities(provider: string, modelId: string): ResolvedModelCapabilities {
  if (provider === 'openrouter') {
    const metadata = readCachedModelsDevOpenRouterMetadata();
    // OpenRouter ids carry routing suffixes (`:nitro`, `:free`, `:online`) but
    // models.dev keys metadata by the base id, so fall back to the
    // suffix-stripped id — mirrors the blackbox base-id fallback below. Without
    // this, every routed (`:nitro`/`:free`) model resolves to EMPTY_CAPABILITIES
    // and silently loses reasoning / structured-output / native-tool gating.
    const meta = metadata?.[modelId] ?? metadata?.[openRouterBaseId(modelId)];
    return meta ? resolveFromOpenRouterMetadata(meta) : EMPTY_CAPABILITIES;
  }

  if (provider === 'blackbox') {
    const metadata = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(
      MODELS_DEV_GLOBAL_PROVIDER_CACHE_KEY,
    );
    const baseId = blackboxBaseId(modelId);
    const meta = metadata?.[modelId] ?? metadata?.[baseId];
    return meta ? resolveFromProviderMetadata(meta) : EMPTY_CAPABILITIES;
  }

  const cacheKey =
    provider === 'nvidia'
      ? MODELS_DEV_NVIDIA_CACHE_KEY
      : provider === 'ollama'
        ? MODELS_DEV_OLLAMA_CACHE_KEY
        : provider === 'zen'
          ? MODELS_DEV_OPENCODE_CACHE_KEY
          : null;

  if (!cacheKey) return EMPTY_CAPABILITIES;

  const metadata = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(cacheKey);
  const meta = metadata?.[modelId];
  return meta ? resolveFromProviderMetadata(meta) : EMPTY_CAPABILITIES;
}

/** Shorthand for checking OpenRouter reasoning support (used by orchestrator). */
export function openRouterModelSupportsReasoning(modelId: string): boolean {
  return getModelCapabilities('openrouter', modelId).reasoning;
}

/**
 * Providers whose web adapter serializes the OpenAI `response_format` json_schema
 * field onto the wire — the OpenAI-shaped endpoints routed through
 * `openAISSEPump`. The Anthropic / Gemini / Vertex native serializers are
 * excluded because they ignore the field by contract (see `ResponseFormatSpec`
 * in `lib/provider-contract.ts`); `bedrock` and `ollama` are omitted because
 * their `response_format` support isn't confirmed (Ollama Cloud does not honor
 * structured outputs per its docs, so attaching one would route around the
 * prompt-only `parseStructured` fallback). `cloudflare` IS included: the
 * Workers AI binding accepts the OpenAI `response_format` shape for the models
 * whose model cards advertise structured outputs (Kimi K2.x, GLM) — but it has
 * no models.dev metadata, so its per-model gate is name-based (see
 * `cloudflareModelSupportsStructuredOutput`). Membership here only governs
 * *whether the wire can honor the constraint* — actual attachment is still
 * gated on per-model capability below, so a provider never attaches a
 * constraint its routed endpoint would silently drop.
 */
const STRUCTURED_OUTPUT_PROVIDERS: ReadonlySet<string> = new Set([
  'openrouter',
  'openai',
  'azure',
  'nvidia',
  'blackbox',
  'kilocode',
  'fireworks',
  'openadapter',
  'zen',
  'cloudflare',
  'anthropic',
]);

/**
 * Name-based structured-output gate for Cloudflare Workers AI. The provider
 * returns bare `@cf/...` ids with no models.dev metadata, so the generic
 * catalog probe can't see capability — mirrors the name-pattern fallback used
 * for context windows (`guessWindowFromName`). Cloudflare's model cards
 * advertise JSON-schema structured outputs for the Kimi K2.x and GLM families
 * specifically; gate on those by name and leave every other Workers AI model
 * prompt-only (it falls back to `parseStructured`).
 *
 * Substring `.includes()` (not anchored) is intentional and matches
 * `guessWindowFromName`: the family token can appear anywhere in the id —
 * notably behind the `@cf/<org>/` prefix (`@cf/moonshotai/kimi-k2.7-code`,
 * `@cf/zai-org/glm-5.2`). A hypothetical `foobar-kimi` matching is the
 * desired behavior — it is a Kimi model — and the downside is only a
 * conservative attempt at a constraint `parseStructured` already backstops.
 */
function cloudflareModelSupportsStructuredOutput(modelId: string): boolean {
  return isCloudflareKimiOrGlm(modelId);
}

/**
 * The Workers AI families whose model cards advertise native JSON capabilities
 * (both `response_format` structured outputs and function calling): Kimi K2.x
 * and GLM. Substring match for the `@cf/<org>/` prefix — see the note on
 * `cloudflareModelSupportsStructuredOutput`.
 */
function isCloudflareKimiOrGlm(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes('kimi') || m.includes('moonshot') || m.includes('glm');
}

/**
 * Whether to attach a native `response_format` JSON-Schema constraint for the
 * given provider/model — gates the auditor verdict/evaluation and reviewer
 * kernels. Two conditions, both required: the provider's adapter must serialize
 * `response_format` (`STRUCTURED_OUTPUT_PROVIDERS`), AND the model's catalog
 * metadata must advertise structured-output support
 * (`getModelCapabilities().structuredOutput`). Generalizes the Phase 1
 * OpenRouter-only gate to every OpenAI-compatible provider; providers without
 * models.dev structured-output metadata (e.g. direct OpenAI / Azure today)
 * resolve `false` and stay prompt-only until that metadata lands.
 */
export function providerModelSupportsStructuredOutput(
  provider: string,
  modelId: string | undefined,
): boolean {
  if (!modelId || !STRUCTURED_OUTPUT_PROVIDERS.has(provider)) return false;
  // Workers AI has no models.dev metadata, so resolve by name instead of the
  // catalog probe (which would always report `structuredOutput: false`).
  if (provider === 'cloudflare') return cloudflareModelSupportsStructuredOutput(modelId);
  // Anthropic has no OpenAI-style `response_format`; the bridge expresses the
  // JSON-Schema constraint as a forced tool (`toAnthropicMessages` →
  // `STRUCTURED_OUTPUT_TOOL_NAME`), which works on any tool-capable Claude — i.e.
  // every model Push offers on this provider. Name-based like Cloudflare (no
  // models.dev structured-output metadata for the native Anthropic ids).
  if (provider === 'anthropic') return true;
  // Zen-Go Anthropic-transport models (minimax/qwen) get structured outputs via
  // the same forced-tool bridge (`handleZenGoChat` → `toAnthropicMessages`),
  // which works regardless of models.dev metadata — same rationale as the direct
  // `anthropic` gate above. Zen's OpenAI-transport models stay capability-gated
  // (`response_format`). `getZenGoTransport` is name-based, so this also enables
  // the dual-tier ids on standard tier, where `response_format` is sent and
  // ignored gracefully if unsupported.
  if (provider === 'zen' && getZenGoTransport(modelId) === 'anthropic') return true;
  return getModelCapabilities(provider, modelId).structuredOutput;
}

/**
 * OpenCode Zen models cleared for native function calling. Name-based (like
 * Cloudflare, unlike OpenRouter's capability gate) because Zen can't be
 * capability-gated reliably: its default `big-pickle` is a Zen-proprietary id
 * that isn't in models.dev at all, and we can't verify the `opencode` block
 * populates `tool_call` for the bare ids — a capability gate would silently
 * leave native FC off for the default and any uncovered model. The curated
 * catalog (`ZEN_MODELS` standard tier + `ZEN_GO_MODELS`) *is* the allowlist:
 * every entry is a current frontier coding model that supports function calling,
 * and deriving the set keeps it in lockstep with catalog refreshes.
 *
 * The Anthropic-transport Go models (`minimax-m3`, `qwen3.7-max`, `qwen3.7-plus`,
 * and the Go routing of `minimax-m2.7` / `qwen3.6-plus`) are also covered: their
 * Go requests serialize through `toAnthropicMessages`, which translates the OpenAI
 * tool schemas to Anthropic's custom-tool shape, and `createAnthropicTranslatedStream`
 * turns the model's `tool_use` blocks back into the fenced JSON the dispatcher
 * consumes (Phase 2 of the Zen Go migration).
 */
const ZEN_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set([
  ...ZEN_MODELS,
  ...ZEN_GO_MODELS,
]);

/**
 * Fireworks AI models cleared for native function calling. Like Zen, name-based
 * against the curated catalog (`FIREWORKS_MODELS`) rather than capability-gated:
 * the list is hand-maintained and every entry is a current frontier coding /
 * instruct model that supports function calling (DeepSeek V4, GLM 5.x, Kimi K2.x,
 * Qwen3.x, MiniMax, GPT-OSS, Nemotron). Deriving the set keeps native FC in
 * lockstep with manual catalog edits — adding a model to `FIREWORKS_MODELS` opts
 * it in. Fireworks is a single OpenAI-compatible endpoint (no transport split),
 * so `fireworks-stream.ts` serializes `tools` straight through and `openai-sse-pump`
 * normalizes the native `tool_calls`.
 */
const FIREWORKS_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(FIREWORKS_MODELS);
const GOOGLE_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(GOOGLE_MODELS);
const KILOCODE_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(KILOCODE_MODELS);
const OPENADAPTER_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(OPENADAPTER_MODELS);
const BLACKBOX_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(BLACKBOX_MODELS);
const OPENAI_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(OPENAI_MODELS);
const ANTHROPIC_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(ANTHROPIC_MODELS);

function looksLikeOpenAIToolCallingModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  return OPENAI_NATIVE_TOOL_CALLING_MODELS.has(modelId) || /^gpt-[45](?:$|[-.]|o)/.test(m);
}

/**
 * Whether to attach native function-calling `tools` for the given
 * provider/model. Provider paths today:
 *   - **Cloudflare Workers AI** (Kimi/GLM) — name-based, the catalog-less
 *     provider this was introduced for.
 *   - **OpenRouter** — capability-based: the model's models.dev metadata must
 *     advertise tool support (`toolCall`). Mirrors the structured-output gate
 *     (`providerModelSupportsStructuredOutput`) so the two can't drift, and
 *     auto-tracks the catalog rather than a hardcoded allowlist.
 *     `getModelCapabilities` is routing-suffix-insensitive (see its
 *     `openRouterBaseId` fallback), so `:nitro` / `:free` variants resolve to
 *     their base model's capability; a cold metadata cache resolves to
 *     `toolCall: false` and safely falls back to text-dispatch.
 *   - **OpenCode Zen** — name-based against the curated catalog
 *     (`ZEN_NATIVE_TOOL_CALLING_MODELS`); see the note there for why capability
 *     gating isn't viable for Zen.
 *   - **Fireworks AI** — name-based against the curated catalog
 *     (`FIREWORKS_NATIVE_TOOL_CALLING_MODELS`).
 *   - **Google Gemini** — name-based against the curated Gemini catalog; the
 *     direct serializer translates OpenAI-shaped tools into Gemini
 *     `functionDeclarations` and the bridge normalizes `functionCall` parts
 *     back into dispatcher JSON.
 *   - **Ollama Cloud / Nvidia NIM / Blackbox AI** — capability-based, using the
 *     existing models.dev metadata caches.
 *   - **OpenAI / Azure OpenAI / Kilo Code / OpenAdapter** — name-based against
 *     curated OpenAI-compatible catalogs or OpenAI-family model ids. Free-text
 *     unknowns stay text-dispatch.
 *   - **Direct Anthropic** — name-based against the curated direct-provider
 *     catalog; the neutral Worker path translates schemas to Anthropic custom
 *     tools and normalizes `tool_use` back to fenced JSON.
 * Other providers stay on the text-dispatch tool protocol until native tool
 * calling is wired and validated for them. Additive regardless: `openai-sse-pump`
 * normalizes any native `tool_calls` back into the fenced JSON the dispatcher
 * consumes, so a non-gated model simply never receives a `tools` array.
 */
export function providerModelSupportsNativeToolCalling(
  provider: string,
  modelId: string | undefined,
): boolean {
  if (!modelId) return false;
  if (provider === 'cloudflare') return isCloudflareKimiOrGlm(modelId);
  if (provider === 'openrouter') return getModelCapabilities('openrouter', modelId).toolCall;
  if (provider === 'zen') return ZEN_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'fireworks') return FIREWORKS_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'google') return GOOGLE_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'ollama') return getModelCapabilities('ollama', modelId).toolCall;
  if (provider === 'nvidia') return getModelCapabilities('nvidia', modelId).toolCall;
  if (provider === 'blackbox') {
    return (
      getModelCapabilities('blackbox', modelId).toolCall ||
      BLACKBOX_NATIVE_TOOL_CALLING_MODELS.has(modelId)
    );
  }
  if (provider === 'openai') return looksLikeOpenAIToolCallingModel(modelId);
  if (provider === 'azure') return looksLikeOpenAIToolCallingModel(modelId);
  if (provider === 'kilocode') return KILOCODE_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'openadapter') return OPENADAPTER_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'anthropic') return ANTHROPIC_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  return false;
}

/** Build a compact icon string for display in model pickers. */

// ---------------------------------------------------------------------------
// Minimum context floor filtering
// ---------------------------------------------------------------------------

interface ContextFilterResult {
  allowed: boolean;
}

/**
 * Fail-closed context filter: rejects models with unknown/missing contextLimit.
 * Priority models (whitelist) bypass the filter even if metadata is missing.
 */
export function filterModelByContext(
  modelId: string,
  contextLimit: number | undefined | null,
  prioritySet: Set<string>,
  failOpen: boolean = false,
): ContextFilterResult {
  // Whitelist override: priority models always pass
  if (prioritySet.has(modelId)) {
    return { allowed: true };
  }

  // Fail closed: unknown/missing contextLimit is rejected (0 is treated as missing —
  // a zero-token context is never valid data, only a coercion artifact)
  if (contextLimit === undefined || contextLimit === null || contextLimit === 0) {
    if (failOpen) {
      console.warn(`[model-catalog] Allowed ${modelId} with missing contextLimit (fail-open)`);
      return { allowed: true };
    }
    console.debug(
      `[model-catalog] Rejected ${modelId}: missing contextLimit (metadata unavailable)`,
    );
    return { allowed: false };
  }

  // Must meet minimum threshold
  if (contextLimit < MIN_CONTEXT_TOKENS) {
    console.debug(
      `[model-catalog] Rejected ${modelId}: contextLimit ${contextLimit} < ${MIN_CONTEXT_TOKENS}`,
    );
    return { allowed: false };
  }

  return { allowed: true };
}
export type ModelCapabilityHint = 'reasoning' | 'vision' | 'imageGen' | 'toolCall';

/**
 * Capability flags for a model, ordered for the picker's hint row. The picker
 * maps each to a bespoke icon (see `push-custom-icons.tsx`); this stays
 * presentation-free so the data layer doesn't own glyphs.
 */
export function getModelCapabilityHints(caps: ResolvedModelCapabilities): ModelCapabilityHint[] {
  const hints: ModelCapabilityHint[] = [];
  if (caps.reasoning) hints.push('reasoning');
  if (caps.vision) hints.push('vision');
  if (caps.imageGen) hints.push('imageGen');
  if (caps.toolCall) hints.push('toolCall');
  return hints;
}

function writeCachedModelsDevOpenRouterMetadata(
  models: Record<string, ModelsDevOpenRouterMetadata>,
): void {
  writeCachedModelsDevMetadata(MODELS_DEV_OPENROUTER_CACHE_KEY, models);
}

function readCachedModelsDevMetadata<TModel>(storageKey: string): Record<string, TModel> | null {
  if (metadataMemCache.has(storageKey)) {
    const cached = metadataMemCache.get(storageKey);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt <= MODELS_DEV_OPENROUTER_CACHE_TTL_MS) {
      return cached.models as Record<string, TModel>;
    }
    metadataMemCache.delete(storageKey);
  }

  const raw = safeStorageGet(storageKey);
  if (!raw) {
    metadataMemCache.set(storageKey, null);
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ModelsDevProviderCachePayload<TModel>> | null;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.models) {
      metadataMemCache.set(storageKey, null);
      return null;
    }
    if (Date.now() - parsed.fetchedAt > MODELS_DEV_OPENROUTER_CACHE_TTL_MS) {
      metadataMemCache.set(storageKey, null);
      return null;
    }
    const result = parsed.models as Record<string, TModel>;
    metadataMemCache.set(storageKey, {
      fetchedAt: parsed.fetchedAt,
      models: result as Record<string, unknown>,
    });
    return result;
  } catch {
    metadataMemCache.set(storageKey, null);
    return null;
  }
}

function writeCachedModelsDevMetadata<TModel>(
  storageKey: string,
  models: Record<string, TModel>,
): void {
  const fetchedAt = Date.now();
  metadataMemCache.set(storageKey, {
    fetchedAt,
    models: models as Record<string, unknown>,
  });
  const payload: ModelsDevProviderCachePayload<TModel> = {
    fetchedAt,
    models,
  };
  safeStorageSet(storageKey, JSON.stringify(payload));
}

function extractModelsDevProviderMetadata(
  payload: unknown,
  providerKey: string,
): Record<string, ModelsDevProviderMetadata> {
  const root = asRecord(payload);
  const provider = root ? asRecord(root[providerKey]) : null;
  const models = provider ? asRecord(provider.models) : null;
  if (!models) return {};

  const entries: Record<string, ModelsDevProviderMetadata> = {};
  for (const [id, value] of Object.entries(models)) {
    const record = asRecord(value);
    if (!record) continue;
    const modalities = asRecord(record.modalities);
    const limits = asRecord(record.limit);
    const resolvedId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : id;
    entries[resolvedId] = {
      id: resolvedId,
      attachment: Boolean(record.attachment),
      reasoning: Boolean(record.reasoning),
      toolCall: Boolean(record.tool_call),
      structuredOutput: Boolean(record.structured_output),
      openWeights: Boolean(record.open_weights),
      inputModalities: normalizeStringArray(modalities?.input),
      outputModalities: normalizeStringArray(modalities?.output),
      contextLimit: typeof limits?.context === 'number' ? limits.context : 0,
    };
  }
  return entries;
}

function mergeProviderMetadata(
  current: ModelsDevProviderMetadata | undefined,
  incoming: ModelsDevProviderMetadata,
): ModelsDevProviderMetadata {
  if (!current) return incoming;

  return {
    id: current.id || incoming.id,
    attachment: current.attachment || incoming.attachment,
    reasoning: current.reasoning || incoming.reasoning,
    toolCall: current.toolCall || incoming.toolCall,
    structuredOutput: current.structuredOutput || incoming.structuredOutput,
    openWeights: current.openWeights || incoming.openWeights,
    inputModalities: Array.from(new Set([...current.inputModalities, ...incoming.inputModalities])),
    outputModalities: Array.from(
      new Set([...current.outputModalities, ...incoming.outputModalities]),
    ),
    contextLimit: Math.max(current.contextLimit, incoming.contextLimit),
  };
}

function extractAllModelsDevProviderMetadata(
  payload: unknown,
): Record<string, ModelsDevProviderMetadata> {
  const root = asRecord(payload);
  if (!root) return {};

  const entries: Record<string, ModelsDevProviderMetadata> = {};
  for (const [providerKey] of Object.entries(root)) {
    const providerEntries = extractModelsDevProviderMetadata(payload, providerKey);
    for (const [id, metadata] of Object.entries(providerEntries)) {
      entries[id] = mergeProviderMetadata(entries[id], metadata);
    }
  }

  return entries;
}

async function fetchModelsDevProviderMetadata(
  providerKey: string,
  cacheKey: string,
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  const cached = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(cacheKey);
  // Auto fetches reuse the 12h cache. A manual refresh forces a revalidation so
  // newly-added upstream models — whose context/capability metadata the curated
  // builders fail-close on when absent — can surface without waiting out the TTL.
  if (cached && !forceRefresh) return cached;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_OPENROUTER_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: forceRefresh ? 'reload' : 'force-cache',
    });
    if (!res.ok) throw new Error(`models.dev metadata failed (${res.status})`);
    const payload = (await res.json()) as unknown;
    const metadata = extractModelsDevProviderMetadata(payload, providerKey);
    if (Object.keys(metadata).length > 0) {
      writeCachedModelsDevMetadata(cacheKey, metadata);
    }
    return metadata;
  } catch {
    return cached ?? {};
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function extractModelsDevOpenRouterMetadata(
  payload: unknown,
): Record<string, ModelsDevOpenRouterMetadata> {
  const root = asRecord(payload);
  const provider = root ? asRecord(root.openrouter) : null;
  const models = provider ? asRecord(provider.models) : null;
  if (!models) return {};

  const entries: Record<string, ModelsDevOpenRouterMetadata> = {};
  for (const [id, value] of Object.entries(models)) {
    const record = asRecord(value);
    if (!record) continue;
    const modalities = asRecord(record.modalities);
    const limits = asRecord(record.limit);
    const resolvedId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : id;
    entries[resolvedId] = {
      id: resolvedId,
      reasoning: Boolean(record.reasoning),
      toolCall: Boolean(record.tool_call),
      structuredOutput: Boolean(record.structured_output),
      openWeights: Boolean(record.open_weights),
      inputModalities: normalizeStringArray(modalities?.input),
      outputModalities: normalizeStringArray(modalities?.output),
      contextLimit: typeof limits?.context === 'number' ? limits.context : 0,
    };
  }
  return entries;
}

async function fetchModelsDevOpenRouterMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevOpenRouterMetadata>> {
  const cached = readCachedModelsDevOpenRouterMetadata();
  if (cached && !forceRefresh) return cached;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_OPENROUTER_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: forceRefresh ? 'reload' : 'force-cache',
    });
    if (!res.ok) throw new Error(`models.dev metadata failed (${res.status})`);
    const payload = (await res.json()) as unknown;
    const metadata = extractModelsDevOpenRouterMetadata(payload);
    if (Object.keys(metadata).length > 0) {
      writeCachedModelsDevOpenRouterMetadata(metadata);
    }
    return metadata;
  } catch {
    return cached ?? {};
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchModelsDevNvidiaMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('nvidia', MODELS_DEV_NVIDIA_CACHE_KEY, forceRefresh);
}

async function fetchModelsDevOllamaMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('ollama-cloud', MODELS_DEV_OLLAMA_CACHE_KEY, forceRefresh);
}

async function fetchModelsDevOpencodeMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('opencode', MODELS_DEV_OPENCODE_CACHE_KEY, forceRefresh);
}

async function fetchModelsDevGlobalProviderMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  const cached = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(
    MODELS_DEV_GLOBAL_PROVIDER_CACHE_KEY,
  );
  if (cached && !forceRefresh) return cached;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_OPENROUTER_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: forceRefresh ? 'reload' : 'force-cache',
    });
    if (!res.ok) throw new Error(`models.dev metadata failed (${res.status})`);
    const payload = (await res.json()) as unknown;
    const metadata = extractAllModelsDevProviderMetadata(payload);
    if (Object.keys(metadata).length > 0) {
      writeCachedModelsDevMetadata(MODELS_DEV_GLOBAL_PROVIDER_CACHE_KEY, metadata);
    }
    return metadata;
  } catch {
    return cached ?? {};
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function parseOpenRouterCatalog(payload: unknown): OpenRouterCatalogModel[] {
  const root = asRecord(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  const models: OpenRouterCatalogModel[] = [];

  for (const item of data) {
    const record = asRecord(item);
    if (!record || typeof record.id !== 'string' || !record.id.trim()) continue;

    const architecture = asRecord(record.architecture);
    const topProvider = asRecord(record.top_provider);
    const fallbackModalities = parseOpenRouterModalityString(architecture?.modality);
    const inputModalities = normalizeStringArray(architecture?.input_modalities);
    const outputModalities = normalizeStringArray(architecture?.output_modalities);

    models.push({
      id: record.id.trim(),
      name:
        typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : record.id.trim(),
      inputModalities:
        inputModalities.length > 0 ? inputModalities : fallbackModalities.inputModalities,
      outputModalities:
        outputModalities.length > 0 ? outputModalities : fallbackModalities.outputModalities,
      supportedParameters: normalizeStringArray(record.supported_parameters),
      contextLength:
        typeof topProvider?.context_length === 'number'
          ? topProvider.context_length
          : typeof record.context_length === 'number'
            ? record.context_length
            : 0,
      isModerated: Boolean(topProvider?.is_moderated),
    });
  }

  return models;
}

/** Strip OpenRouter routing suffixes (:nitro, :free, etc.) for catalog/metadata lookups. */
function openRouterBaseId(id: string): string {
  const colon = id.lastIndexOf(':');
  return colon > 0 ? id.slice(0, colon) : id;
}

export function buildCuratedOpenRouterModelList(
  models: OpenRouterCatalogModel[],
  metadataById?: Record<string, ModelsDevOpenRouterMetadata>,
): string[] {
  const liveIds = new Set(models.map((m) => m.id));

  const prioritySet = new Set<string>(OPENROUTER_PRIORITY_MODELS);
  const modelsById = Object.fromEntries(models.map((m) => [m.id, m]));
  // Priority models bypass the context floor but must be in the live catalog.
  const curated = OPENROUTER_PRIORITY_MODELS.filter((id) => {
    // Match against catalog using base ID (catalog lists base models, not routing variants)
    const baseId = openRouterBaseId(id);
    if (!liveIds.has(id) && !liveIds.has(baseId)) return false;
    const meta = metadataById?.[id] ?? metadataById?.[baseId];
    // When metadata is available, exclude image-output-only models
    if (meta?.outputModalities?.includes('image') && !meta.outputModalities?.includes('text'))
      return false;
    const contextLimit =
      meta?.contextLimit ?? modelsById[id]?.contextLength ?? modelsById[baseId]?.contextLength;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });

  // Any live model whose base ID is already pinned (directly or via a :nitro variant)
  // is considered covered and should not be duplicated in the tail.
  const covered = new Set<string>();
  for (const id of curated) {
    covered.add(id);
    covered.add(openRouterBaseId(id));
  }

  const tail: string[] = [];
  for (const m of models) {
    if (covered.has(m.id)) continue;
    if (!m.outputModalities.includes('text')) continue;
    if (m.contextLength < MIN_CONTEXT_TOKENS) continue;
    // Respect models.dev metadata exclusions so a base model we already
    // rejected from the priority block (e.g. flagged image-only by metadata
    // even though the OpenRouter catalog reports text) does not resurface.
    const meta = metadataById?.[m.id];
    if (meta?.outputModalities?.includes('image') && !meta.outputModalities.includes('text'))
      continue;
    // Share the provider-wide family filter so embed/rerank/retrieval/
    // image-generation families stay consistent with other providers.
    if (!isProviderTextChatModel(m.id, meta)) continue;
    tail.push(m.id);
  }
  tail.sort((a, b) => a.localeCompare(b));

  return [...curated, ...tail];
}

/**
 * Structural shape used by {@link isProviderTextChatModel} — only the
 * output-modalities field matters for the text-chat filter. Typed as a
 * minimal structural type so both {@link ModelsDevProviderMetadata} and
 * {@link ModelsDevOpenRouterMetadata} satisfy it without requiring the
 * OpenRouter shape to carry a `attachment` flag it never reports.
 */
type TextChatFilterMetadata = {
  outputModalities?: readonly string[];
};

function isProviderTextChatModel(id: string, metadata?: TextChatFilterMetadata): boolean {
  // Check for image output or non-text-only modalities
  if (metadata?.outputModalities?.includes('image')) return false;
  if (
    (metadata?.outputModalities?.length ?? 0) > 0 &&
    !metadata?.outputModalities?.includes('text')
  )
    return false;

  const normalized = id.toLowerCase();
  if (IMAGE_GENERATION_MODEL_FAMILY_REGEX.test(normalized)) return false;
  if (/(embed|embedding|rerank|retriev|nv-rerank|nvolve)/.test(normalized)) return false;
  return true;
}

function isNvidiaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  return isProviderTextChatModel(id, metadata);
}

export function buildCuratedNvidiaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(NVIDIA_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isNvidiaChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = NVIDIA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as (typeof NVIDIA_PRIORITY_MODELS)[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, NVIDIA_MAX_CURATED_MODELS);
}

function isOllamaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

export function buildCuratedOllamaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(OLLAMA_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isOllamaChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet, true);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = OLLAMA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as (typeof OLLAMA_PRIORITY_MODELS)[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, OLLAMA_MAX_CURATED_MODELS);
}

function isOpencodeChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

function blackboxBaseId(id: string): string {
  return id.trim().replace(/^blackboxai\//i, '');
}

const BLACKBOX_NON_CHAT_FAMILY_REGEX =
  /animatediff|(?:^|[-_/:.])svd(?:$|[-_/:.])|mochi(?:$|[-_/:.])|hunyuan(?:$|[-_/:.])|(?:^|[-_/:.])lora(?:$|[-_/:.])|gemini-flash-edit/i;

const BLACKBOX_ALIAS_PROVIDER_PREFIXES: Array<[RegExp, string]> = [
  [/^claude\b/i, 'anthropic'],
  [/^(?:gpt|o1\b|o3\b|o4\b|codex\b)/i, 'openai'],
  [/^gemini\b/i, 'google'],
  [/^(?:llama|meta\b)/i, 'meta'],
  [/^qwen\b/i, 'qwen'],
  [/^(?:kimi|moonshot)\b/i, 'moonshotai'],
  [/^glm\b/i, 'z-ai'],
  [/^deepseek\b/i, 'deepseek'],
  [/^(?:mistral|codestral|devstral)\b/i, 'mistralai'],
  [/^sonar\b/i, 'perplexity'],
  [/^grok\b/i, 'x-ai'],
];

function inferBlackboxAliasProvider(normalizedLeaf: string): string | null {
  for (const [pattern, provider] of BLACKBOX_ALIAS_PROVIDER_PREFIXES) {
    if (pattern.test(normalizedLeaf)) return provider;
  }
  return null;
}

function normalizeBlackboxAliasLeaf(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^blackboxai\//i, '')
    .replace(/_/g, '-')
    .replace(/[-_.]?20\d{6}$/, '')
    .replace(/(\d)-(\d)/g, '$1.$2');
}

function getBlackboxDedupKey(id: string): string {
  const baseId = blackboxBaseId(id);
  const slash = baseId.indexOf('/');
  if (slash > 0) {
    const provider = baseId.slice(0, slash).toLowerCase();
    const leaf = baseId.slice(slash + 1);
    return `${provider}/${normalizeBlackboxAliasLeaf(leaf)}`;
  }

  const normalizedLeaf = normalizeBlackboxAliasLeaf(baseId);
  const inferredProvider = inferBlackboxAliasProvider(normalizedLeaf);
  if (inferredProvider) return `${inferredProvider}/${normalizedLeaf}`;
  return `blackbox/${normalizedLeaf}`;
}

function prefersBlackboxModelId(nextId: string, currentId: string): boolean {
  const nextBase = blackboxBaseId(nextId);
  const currentBase = blackboxBaseId(currentId);
  const nextIsRouted = nextBase.includes('/');
  const currentIsRouted = currentBase.includes('/');
  if (nextIsRouted !== currentIsRouted) return nextIsRouted;

  const nextLabel = normalizeBlackboxAliasLeaf(nextBase);
  const currentLabel = normalizeBlackboxAliasLeaf(currentBase);
  if (nextLabel !== currentLabel)
    return (
      nextLabel.localeCompare(currentLabel, undefined, { numeric: true, sensitivity: 'base' }) < 0
    );

  return nextBase.localeCompare(currentBase, undefined, { numeric: true, sensitivity: 'base' }) < 0;
}

function isClearlyNonPushBlackboxModel(id: string): boolean {
  return BLACKBOX_NON_CHAT_FAMILY_REGEX.test(id.toLowerCase());
}

function isExplicitlySmallBlackboxModel(id: string): boolean {
  const normalized = id.toLowerCase();
  if (/(?:^|[-_/:.])(nano|tiny)(?:$|[-_/:.])/.test(normalized)) return true;

  // Avoid misclassifying MoE names like 8x22b as "22b" single-size models.
  if (/\d+x\d+(?:\.\d+)?b\b/.test(normalized)) return false;

  const sizeMatches = normalized.matchAll(/(\d+(?:\.\d+)?)b\b/g);
  for (const match of sizeMatches) {
    const sizeInBillions = Number(match[1]);
    if (Number.isFinite(sizeInBillions) && sizeInBillions < BLACKBOX_MIN_PARAMETER_BILLIONS) {
      return true;
    }
  }

  return false;
}

export function buildCuratedBlackboxModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const deduped = new Map<string, string>();

  for (const rawId of modelIds) {
    const baseId = blackboxBaseId(rawId);
    const metadata = metadataById[rawId] ?? metadataById[baseId];
    if (!isProviderTextChatModel(baseId, metadata)) continue;
    if (isClearlyNonPushBlackboxModel(baseId)) continue;
    if (isExplicitlySmallBlackboxModel(baseId)) continue;

    const dedupKey = getBlackboxDedupKey(baseId);
    const existing = deduped.get(dedupKey);
    if (!existing || prefersBlackboxModelId(rawId, existing)) {
      deduped.set(dedupKey, rawId);
    }
  }

  const candidates = Array.from(deduped.values());

  if (candidates.length === 0) return [];

  return [...candidates].sort((a, b) => compareProviderModelIds('blackbox', a, b));
}

export function buildCuratedOpencodeModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(OPENCODE_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isOpencodeChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = OPENCODE_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as (typeof OPENCODE_PRIORITY_MODELS)[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, OPENCODE_MAX_CURATED_MODELS);
}

function normalizeModelList(payload: unknown): string[] {
  const ids = new Set<string>();

  const maybePushId = (value: unknown): number => {
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      const sizeBefore = ids.size;
      ids.add(trimmed);
      return ids.size > sizeBefore ? 1 : 0;
    }
    return 0;
  };

  const fromArray = (arr: unknown[], allowName: boolean) => {
    let added = 0;
    for (const item of arr) {
      if (typeof item === 'string') {
        added += maybePushId(item);
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      added += maybePushId(rec.id);
      added += maybePushId(rec.model);
      if (allowName) {
        added += maybePushId(rec.name);
      }
    }
    return added;
  };

  const visited = new WeakSet<object>();
  const fromRecord = (rec: Record<string, unknown>) => {
    if (visited.has(rec)) return;
    visited.add(rec);

    if (Array.isArray(rec.data)) {
      const added = fromArray(rec.data, false);
      if (added === 0) fromArray(rec.data, true);
    }
    if (Array.isArray(rec.models)) fromArray(rec.models, true);
    if (Array.isArray(rec.items)) fromArray(rec.items, false);
    if (Array.isArray(rec.list)) fromArray(rec.list, false);
    if (Array.isArray(rec.model_list)) fromArray(rec.model_list, false);

    const nestedData = asRecord(rec.data);
    if (nestedData) fromRecord(nestedData);
    const nestedResult = asRecord(rec.result);
    if (nestedResult) fromRecord(nestedResult);
    const nestedOutput = asRecord(rec.output);
    if (nestedOutput) fromRecord(nestedOutput);
  };

  if (Array.isArray(payload)) {
    fromArray(payload, true);
  } else {
    const rec = asRecord(payload);
    if (rec) fromRecord(rec);
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export async function fetchOllamaModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getOllamaKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.ollama.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOllamaMetadata(opts.forceMetadataRefresh),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`Ollama model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedOllamaModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Ollama model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchOpenRouterModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getOpenRouterKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.openrouter.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOpenRouterMetadata(opts.forceMetadataRefresh),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(
        `OpenRouter model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = parseOpenRouterCatalog(payload);
    const curated = buildCuratedOpenRouterModelList(liveModels, modelsDevMetadata);
    if (curated.length > 0) return curated;
    // Fallback: use catalog contextLength to apply basic context floor filter
    return liveModels
      .filter((m) => m.outputModalities.includes('text') && m.contextLength >= MIN_CONTEXT_TOKENS)
      .map((m) => m.id);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `OpenRouter model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchCloudflareModels(): Promise<string[]> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(PROVIDER_URLS.cloudflare.models, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Cloudflare Workers AI model list failed (${response.status}): ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as unknown;
    // `/api/cloudflare/models` returns a bare `string[]` of `@cf/...` ids.
    // We avoid `normalizeModelList` because the CF binding's own catalog
    // pairs a UUID `id` with the `@cf/...` `name`, and the shared normalizer
    // would wrongly treat both as selectable ids.
    const liveModels = (Array.isArray(payload) ? payload : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .sort((left, right) => compareProviderModelIds('cloudflare', left, right));
    return liveModels.length > 0 ? liveModels : [...CLOUDFLARE_MODELS];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Cloudflare Workers AI model list timed out after ${Math.floor(
          MODELS_FETCH_TIMEOUT_MS / 1000,
        )}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchZenModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getZenKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.zen.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOpencodeMetadata(opts.forceMetadataRefresh),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(
        `OpenCode Zen model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedOpencodeModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `OpenCode Zen model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchNvidiaModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getNvidiaKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.nvidia.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevNvidiaMetadata(opts.forceMetadataRefresh),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(
        `Nvidia NIM model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedNvidiaModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Nvidia NIM model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchBlackboxModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getBlackboxKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.blackbox.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevGlobalProviderMetadata(opts.forceMetadataRefresh),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(
        `Blackbox AI model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedBlackboxModelList(liveModels, modelsDevMetadata);
    // Keep Blackbox on a lightweight provider-specific filter: preserve good chat/code
    // models from the live catalog while dropping obvious image/non-text/tiny variants.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Blackbox AI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchKilocodeModels(): Promise<string[]> {
  const key = getKilocodeKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.kilocode.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Kilo Code model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('kilocode', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Kilo Code model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchFireworksModels(): Promise<string[]> {
  const key = getFireworksKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.fireworks.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Fireworks AI model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('fireworks', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Fireworks AI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchOpenAdapterModels(): Promise<string[]> {
  const key = getOpenAdapterKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.openadapter.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAdapter model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('openadapter', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `OpenAdapter model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// OpenAI and Google live model lists are filtered Worker-side
// (`handleOpenAIModels` / `handleGoogleModels` drop embeddings/audio/image-only
// entries and fall back to the curated list on key-missing/upstream failure),
// so the client just normalizes the OpenAI-shaped `{ data: [{ id }] }` payload.
// No models.dev metadata pass is needed here — hence no forceMetadataRefresh
// option — and the Worker's `cache: 'no-store'` keeps each refresh live.
export async function fetchOpenAIModels(): Promise<string[]> {
  const key = getOpenAIKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.openai.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('openai', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `OpenAI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchGoogleModels(): Promise<string[]> {
  const key = getGoogleKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.google.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google Gemini model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('google', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Google Gemini model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
