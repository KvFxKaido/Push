import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { safeStorageGet, safeStorageSet } from './safe-storage';
import {
  ANTHROPIC_MODELS,
  CLOUDFLARE_MODELS,
  compareProviderModelIds,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  KILOCODE_MODELS,
  NVIDIA_MODELS,
  OPENROUTER_MODELS,
  PROVIDER_URLS,
  SAKANA_MODELS,
  ZEN_GO_MODELS,
  ZEN_MODELS,
} from './providers';
import { getZenGoTransport } from './zen-go';
import { getVertexModelTransport } from './vertex-provider';
import { getVertexMode } from '@/hooks/useVertexConfig';
import { asRecord } from './utils';
import {
  DEFAULT_PUSH_CAPABILITY_PROFILE,
  type PushCapabilityProfile,
  type PushContextTier,
  type PushStructuredOutputMode,
} from './capabilities';
import { anthropicModelSupportsNativeStructuredOutput } from '@push/lib/anthropic-structured-output';
import {
  looksLikeBedrockAnthropicToolCallingModel,
  looksLikeOpenAIToolCallingModel,
  OLLAMA_NATIVE_TOOL_CALLING_DENYLIST,
  VERTEX_NATIVE_TOOL_CALLING_MODELS,
} from '@push/lib/native-tool-gate';
import {
  providerCarriesReasoningBlocksByDefault,
  providerConsumesContentBlocksByDefault,
} from '@push/lib/provider-definition';
import { lookupDeclaredModelMetadata, type DeclaredModelMetadata } from '@push/lib/model-metadata';

const MODELS_FETCH_TIMEOUT_MS = 12_000;
const MODELS_DEV_OPENROUTER_URL = 'https://models.dev/api.json';
const MODELS_DEV_OPENROUTER_CACHE_KEY = 'push:models-dev:openrouter-models';
const MODELS_DEV_NVIDIA_CACHE_KEY = 'push:models-dev:nvidia-models';
const MODELS_DEV_OLLAMA_CACHE_KEY = 'push:models-dev:ollama-cloud-models';
const MODELS_DEV_OPENCODE_CACHE_KEY = 'push:models-dev:opencode-models';
const MODELS_DEV_OPENROUTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
// Cloudflare Workers AI catalog cache. Unlike the other providers, Cloudflare
// has no models.dev metadata — the binding's own catalog (surfaced by
// `/api/cloudflare/models`) is the single source for both the model list and
// its capability flags, so we cache the whole enriched payload here. The list
// changes infrequently (Cloudflare adds/removes models), so a 12h TTL matches
// the models.dev cadence; the picker's manual refresh forces a revalidation.
const CLOUDFLARE_CATALOG_CACHE_KEY = 'push:cloudflare:catalog';
const CLOUDFLARE_CATALOG_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NVIDIA_MAX_CURATED_MODELS = 32;
const OLLAMA_MAX_CURATED_MODELS = 40;
const OPENCODE_MAX_CURATED_MODELS = 48;
export const MIN_CONTEXT_TOKENS = 64000;
// Use the shared curated list as the single source of truth for priority ordering.
// To add a new OpenRouter model, update OPENROUTER_MODELS in lib/provider-models.ts.
const OPENROUTER_PRIORITY_MODELS: readonly string[] = OPENROUTER_MODELS;
const NVIDIA_PRIORITY_MODELS: readonly string[] = NVIDIA_MODELS;
// Refreshed against Ollama Cloud's 2026-07 retirement notice: dropped
// gemini-3-flash-preview, glm-5, qwen3-coder-next, qwen3-coder:480b,
// deepseek-v3.2, devstral-2:123b, gemma3:27b in favor of Ollama's
// recommended replacements. Priority only orders the live `/models`
// response, so ids not yet on an account simply don't surface.
const OLLAMA_PRIORITY_MODELS = [
  'minimax-m3',
  'glm-5.2',
  'qwen3.5:397b',
  'kimi-k2.5',
  'deepseek-v4-flash',
  'mistral-large-3:675b',
  'qwen3-vl:235b-instruct',
  'gemma4:31b',
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
// Cloudflare Workers AI catalog cache (list + capability flags)
// ---------------------------------------------------------------------------

/** Capability flags resolved from the cached Cloudflare binding catalog. */
export interface CloudflareModelCapabilities {
  functionCalling: boolean;
}

/** One catalog entry as persisted in the cache / returned by the Worker. */
export interface CloudflareCatalogModel {
  id: string;
  functionCalling: boolean;
}

interface CloudflareCatalogCachePayload {
  fetchedAt: number;
  models: CloudflareCatalogModel[];
}

// Single-entry mem-cache (the catalog is one global list, not keyed by id)
// fronting localStorage so the synchronous capability gates don't re-parse on
// every call. Null until first read; refreshed on every write.
let cloudflareCatalogMemCache: CloudflareCatalogCachePayload | null = null;

function readCloudflareCatalogCache(): CloudflareCatalogModel[] | null {
  if (cloudflareCatalogMemCache) {
    if (Date.now() - cloudflareCatalogMemCache.fetchedAt <= CLOUDFLARE_CATALOG_CACHE_TTL_MS) {
      return cloudflareCatalogMemCache.models;
    }
    cloudflareCatalogMemCache = null;
  }

  const raw = safeStorageGet(CLOUDFLARE_CATALOG_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<CloudflareCatalogCachePayload> | null;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CLOUDFLARE_CATALOG_CACHE_TTL_MS) return null;
    cloudflareCatalogMemCache = { fetchedAt: parsed.fetchedAt, models: parsed.models };
    return parsed.models;
  } catch {
    return null;
  }
}

function writeCloudflareCatalogCache(models: CloudflareCatalogModel[]): void {
  const fetchedAt = Date.now();
  cloudflareCatalogMemCache = { fetchedAt, models };
  safeStorageSet(CLOUDFLARE_CATALOG_CACHE_KEY, JSON.stringify({ fetchedAt, models }));
}

/**
 * Normalize the `/api/cloudflare/models` payload into catalog entries. Accepts
 * the enriched object form (`{ id, functionCalling }[]`) and tolerates a bare
 * `string[]` (a stale cache blob or an older Worker) by defaulting capabilities
 * off — the conservative side, since `parseStructured` / text-dispatch backstop
 * a model we under-claim, whereas over-claiming would attach a constraint the
 * model silently drops.
 */
function parseCloudflareCatalogPayload(payload: unknown): CloudflareCatalogModel[] {
  if (!Array.isArray(payload)) return [];
  const out: CloudflareCatalogModel[] = [];
  for (const entry of payload) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id) out.push({ id, functionCalling: false });
      continue;
    }
    const rec = asRecord(entry);
    const id = typeof rec?.id === 'string' ? rec.id.trim() : '';
    if (!id) continue;
    out.push({ id, functionCalling: rec?.functionCalling === true });
  }
  return out;
}

/**
 * Capability flags for a Cloudflare Workers AI model, resolved from the cached
 * binding catalog. Returns null when the catalog hasn't been fetched yet (cold
 * cache) or the model isn't in it, so callers fall back to name-based gating.
 */
export function getCloudflareModelCapabilities(
  modelId: string,
): CloudflareModelCapabilities | null {
  const catalog = readCloudflareCatalogCache();
  if (!catalog) return null;
  const entry = catalog.find((model) => model.id === modelId);
  return entry ? { functionCalling: entry.functionCalling } : null;
}

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

export interface PushCapabilityProfileOptions {
  /** Request body contract for this route. `neutral` routes consume contentBlocks. */
  requestWire?: 'neutral' | 'openai';
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
    // Vision = image input only. models.dev's `attachment` flag means the model
    // accepts file attachments of *some* kind (frequently PDF/file, sometimes
    // audio) — it is not an image-vision signal. Across the full models.dev
    // catalog, `modalities.input` is always populated when `attachment` is set
    // (0 models have attachment + empty modalities), and 157 models set
    // attachment without `image` (e.g. text-only `openai/gpt-4`, audio-only
    // `whisper-large-v3`). OR-ing `attachment` in mismarked those as vision.
    vision: meta.inputModalities.includes('image'),
    imageGen: meta.outputModalities.includes('image'),
    structuredOutput: meta.structuredOutput,
    contextLimit: meta.contextLimit,
  };
}

function resolveFromDeclaredMetadata(meta: DeclaredModelMetadata): ResolvedModelCapabilities {
  return {
    reasoning: meta.reasoning,
    toolCall: meta.toolCall,
    // Vision = image input only. Declared `attachment` also covers PDF/file input
    // (it defaults to image||pdf), so a PDF-only model (TEXT_PDF) must not be
    // marked image-capable — matching resolveFromOpenRouterMetadata above.
    vision: meta.inputModalities.includes('image'),
    imageGen: meta.outputModalities.includes('image'),
    structuredOutput: meta.structuredOutput,
    contextLimit: meta.contextLimit,
  };
}

function resolveDeclaredModelCapabilities(
  provider: string,
  modelId: string,
): ResolvedModelCapabilities {
  const meta = lookupDeclaredModelMetadata(provider, modelId);
  return meta ? resolveFromDeclaredMetadata(meta) : EMPTY_CAPABILITIES;
}

/**
 * Look up cached model capabilities from models.dev metadata.
 * Works for any provider — checks OpenRouter, Ollama, Nvidia, and OpenCode
 * routed IDs against cached metadata.
 */
export function getModelCapabilities(provider: string, modelId: string): ResolvedModelCapabilities {
  if (provider === 'openrouter') {
    const metadata = readCachedModelsDevOpenRouterMetadata();
    // OpenRouter ids carry routing suffixes (`:nitro`, `:free`, `:online`) but
    // models.dev keys metadata by the base id, so fall back to the
    // suffix-stripped id. Without this, every routed (`:nitro`/`:free`) model
    // resolves to EMPTY_CAPABILITIES and silently loses reasoning /
    // structured-output / native-tool gating.
    const meta = metadata?.[modelId] ?? metadata?.[openRouterBaseId(modelId)];
    return meta
      ? resolveFromOpenRouterMetadata(meta)
      : resolveDeclaredModelCapabilities(provider, modelId);
  }

  const cacheKey =
    provider === 'nvidia'
      ? MODELS_DEV_NVIDIA_CACHE_KEY
      : provider === 'ollama'
        ? MODELS_DEV_OLLAMA_CACHE_KEY
        : provider === 'zen'
          ? MODELS_DEV_OPENCODE_CACHE_KEY
          : null;

  if (!cacheKey) return resolveDeclaredModelCapabilities(provider, modelId);

  const metadata = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(cacheKey);
  const meta = metadata?.[modelId];
  return meta
    ? resolveFromProviderMetadata(meta)
    : resolveDeclaredModelCapabilities(provider, modelId);
}

/** Shorthand for checking OpenRouter reasoning support (used by orchestrator). */
export function openRouterModelSupportsReasoning(modelId: string): boolean {
  return getModelCapabilities('openrouter', modelId).reasoning;
}

/**
 * Providers whose web adapter can honor Push's neutral `ResponseFormatSpec`.
 * OpenAI-compatible endpoints serialize it as `response_format`; Anthropic
 * Messages routes serialize it as native `output_config.format` when supported
 * and fall back to the forced-tool bridge otherwise. Gemini native serializers,
 * Bedrock, and Ollama are omitted because their structured-output support is
 * either absent or unconfirmed, so attaching one would route around the
 * prompt-only `parseStructured` fallback. `cloudflare` IS included: the
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
  'kilocode',
  'fireworks',
  'sakana',
  'zen',
  'cloudflare',
  'anthropic',
  'vertex',
  'google',
]);

/**
 * Structured-output gate for Cloudflare Workers AI. Resolves from the binding
 * catalog's `function_calling` flag (Workers AI ships function calling and JSON
 * mode together, so the same flag governs both) and falls back to the Kimi/GLM
 * name heuristic on a cold cache — see {@link cloudflareFunctionCallingGate}.
 * Models we under-claim simply fall back to `parseStructured`.
 */
function cloudflareModelSupportsStructuredOutput(modelId: string): boolean {
  return cloudflareFunctionCallingGate(modelId);
}

/**
 * Resolve Workers AI capability for `modelId`, preferring the binding catalog's
 * `function_calling` flag (cached from `/api/cloudflare/models`) and falling
 * back to the name-based Kimi/GLM heuristic only when the catalog hasn't been
 * fetched yet or doesn't list the model. Both the native-tool and
 * structured-output gates route through here: Workers AI ships function calling
 * and JSON mode together, so a single catalog flag drives both, and the
 * name-based fallback preserves the prior behavior on a cold cache.
 */
function cloudflareFunctionCallingGate(modelId: string): boolean {
  const caps = getCloudflareModelCapabilities(modelId);
  if (caps) return caps.functionCalling;
  return isCloudflareKimiOrGlm(modelId);
}

/**
 * Cold-cache fallback for the Workers AI capability gates: the families whose
 * model cards advertise native JSON capabilities (both `response_format`
 * structured outputs and function calling), Kimi K2.x and GLM. Used only until
 * the binding catalog loads its `function_calling` flags (see
 * {@link cloudflareFunctionCallingGate}); once it does, the catalog is
 * authoritative and this name match no longer runs. Substring `.includes()`
 * (not anchored) is intentional: the family token can appear anywhere in the id,
 * notably behind the `@cf/<org>/` prefix (`@cf/moonshotai/kimi-k2.7-code`,
 * `@cf/zai-org/glm-5.2`).
 */
function isCloudflareKimiOrGlm(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes('kimi') || m.includes('moonshot') || m.includes('glm');
}

function resolveContextTier(contextLimit: number): PushContextTier {
  if (contextLimit >= 200_000) return 'large';
  if (contextLimit >= MIN_CONTEXT_TOKENS || contextLimit === 0) return 'medium';
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

function routeCarriesReasoningBlocks(provider: string, modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (providerCarriesReasoningBlocksByDefault(provider)) return true;
  if (provider === 'zen') return getZenGoTransport(modelId) === 'anthropic';
  if (provider === 'vertex') return getVertexModelTransport(modelId) === 'anthropic';
  return false;
}

function modelSupportsMultimodal(
  provider: string,
  modelId: string,
  capabilities: ResolvedModelCapabilities,
): boolean {
  if (capabilities.vision) return true;
  if (provider === 'anthropic' || provider === 'google') return true;
  if (provider === 'vertex') {
    return getVertexModelTransport(modelId) === 'anthropic' || /gemini/i.test(modelId);
  }
  return /(?:gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|vl\b|llava|bakllava)/i.test(modelId);
}

function resolveStructuredOutputMode(
  provider: string,
  modelId: string | undefined,
): PushStructuredOutputMode {
  if (!modelId || !STRUCTURED_OUTPUT_PROVIDERS.has(provider)) return 'none';
  // Workers AI has no models.dev metadata, so resolve by name instead of the
  // catalog probe (which would always report `structuredOutput: false`).
  if (provider === 'cloudflare') {
    return cloudflareModelSupportsStructuredOutput(modelId) ? 'strict' : 'none';
  }
  // Direct Anthropic gets native `output_config.format` on supported Claude
  // models and keeps the forced-tool bridge on older/unknown Claude ids.
  if (provider === 'anthropic') {
    return anthropicModelSupportsNativeStructuredOutput(modelId) ? 'strict' : 'best-effort';
  }
  // Anthropic-transport routes share the Messages serializer. Claude models on
  // Vertex can use `output_config.format`; older Claude ids and Zen-Go
  // MiniMax/Qwen routes keep the forced-tool fallback.
  if (provider === 'vertex') {
    if (getVertexModelTransport(modelId) !== 'anthropic') return 'none';
    // Only the native (push.stream.v1) Vertex wire reaches `toAnthropicMessages`,
    // where the constraint becomes `output_config.format` / the forced tool. The
    // legacy OpenAI-proxy wire (`vertexStream`'s `legacyBase`) never serializes
    // `response_format`, and its upstream base URL is user-configured/unconfirmed —
    // attaching a constraint there would silently route around the prompt-only
    // `parseStructured` fallback. Keep legacy Vertex prompt-only. Reads the same
    // `getVertexMode()` ground truth `vertexStream` uses for its `requestWire`, so
    // gate and wire stay in lockstep.
    if (getVertexMode() !== 'native') return 'none';
    return anthropicModelSupportsNativeStructuredOutput(modelId) ? 'strict' : 'best-effort';
  }
  if (provider === 'zen' && getZenGoTransport(modelId) === 'anthropic') {
    return anthropicModelSupportsNativeStructuredOutput(modelId) ? 'strict' : 'best-effort';
  }
  // Gemini constrains generation natively via `responseSchema` + JSON mime type
  // (`toGeminiGenerateContent`). Gated on the same curated set as native tool
  // calling so the two `google` gates stay consistent (no cross-column drift, the
  // failure mode the #1169 harness flagged for opus-4-8). `strict` because Gemini
  // enforces the schema structurally, not as a hint.
  if (provider === 'google') {
    return GOOGLE_NATIVE_TOOL_CALLING_MODELS.has(modelId) ? 'strict' : 'none';
  }
  return getModelCapabilities(provider, modelId).structuredOutput ? 'strict' : 'none';
}

/**
 * Whether to attach a native `response_format` JSON-Schema constraint for the
 * given provider/model — gates the auditor verdict/evaluation and reviewer
 * kernels. OpenAI-compatible providers emit OpenAI `response_format`;
 * Anthropic Messages routes emit native `output_config.format` where supported
 * and fall back to the forced-tool bridge where not. Providers without a
 * confirmed structured-output wire stay prompt-only until their adapter proves
 * support.
 */
export function providerModelSupportsStructuredOutput(
  provider: string,
  modelId: string | undefined,
): boolean {
  return resolvePushCapabilityProfile(provider, modelId).structuredOutput !== 'none';
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
 * tool schemas to Anthropic's custom-tool shape, and the model's `tool_use` blocks
 * are parsed natively into `native_tool_call` events by `anthropicEventStream` —
 * the foreground `zenStream` and the background coder-job adapter both parse the
 * raw Anthropic SSE directly, no OpenAI-SSE translator in between.
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
const SAKANA_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(SAKANA_MODELS);
const GOOGLE_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(GOOGLE_MODELS);
const KILOCODE_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(KILOCODE_MODELS);
const ANTHROPIC_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(ANTHROPIC_MODELS);
// `looksLikeOpenAIToolCallingModel`, `looksLikeBedrockAnthropicToolCallingModel`,
// and `VERTEX_NATIVE_TOOL_CALLING_MODELS` are shared with the CLI gate via
// `@push/lib/native-tool-gate` (single definition; pinned by the web↔CLI drift
// test below). Capability-based providers stay resolved here (models.dev).

/**
 * Whether to attach native function-calling `tools` for the given
 * provider/model. Provider paths today:
 *   - **Cloudflare Workers AI** — catalog-based: the binding catalog's
 *     `function_calling` flag (cached from `/api/cloudflare/models`), falling
 *     back to the Kimi/GLM name heuristic only on a cold cache.
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
 *   - **Google Vertex AI** — name-based against the curated Vertex model list;
 *     Gemini models use the OpenAI-compatible endpoint (`tools` straight
 *     through) and Claude models use the Anthropic custom-tool bridge.
 *   - **AWS Bedrock** — name-based for Claude 3+ / Claude 4-style Anthropic
 *     model ids routed through the OpenAI-compatible proxy (`tools` straight
 *     through).
 *   - **Ollama Cloud / Nvidia NIM** — capability-based, using the
 *     existing models.dev metadata caches.
 *   - **OpenAI / Azure OpenAI / Kilo Code** — name-based against
 *     curated OpenAI-compatible catalogs or OpenAI-family model ids. Free-text
 *     unknowns stay text-dispatch.
 *   - **Direct Anthropic** — name-based against the curated direct-provider
 *     catalog; the neutral Worker path translates schemas to Anthropic custom
 *     tools and surfaces `tool_use` as structured native tool-call events.
 * Other providers stay on the text-dispatch tool protocol until native tool
 * calling is wired and validated for them. Additive regardless: non-gated
 * models simply never receive a `tools` array.
 */
function modelSupportsNativeToolCalling(provider: string, modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (provider === 'cloudflare') return cloudflareFunctionCallingGate(modelId);
  if (provider === 'openrouter') return getModelCapabilities('openrouter', modelId).toolCall;
  if (provider === 'zen') return ZEN_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'fireworks') return FIREWORKS_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'sakana') return SAKANA_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'google') return GOOGLE_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'vertex') return VERTEX_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'bedrock') return looksLikeBedrockAnthropicToolCallingModel(modelId);
  if (provider === 'ollama') {
    return (
      !OLLAMA_NATIVE_TOOL_CALLING_DENYLIST.has(modelId) &&
      getModelCapabilities('ollama', modelId).toolCall
    );
  }
  if (provider === 'nvidia') return getModelCapabilities('nvidia', modelId).toolCall;
  if (provider === 'openai') return looksLikeOpenAIToolCallingModel(modelId);
  if (provider === 'azure') return looksLikeOpenAIToolCallingModel(modelId);
  if (provider === 'kilocode') return KILOCODE_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  if (provider === 'anthropic') return ANTHROPIC_NATIVE_TOOL_CALLING_MODELS.has(modelId);
  return false;
}

export function resolvePushCapabilityProfile(
  provider: string,
  modelId: string | undefined,
  options?: PushCapabilityProfileOptions,
): PushCapabilityProfile {
  const model = modelId?.trim();
  const contentBlocks = routeConsumesContentBlocks(provider, options);
  const reasoningBlocks = routeCarriesReasoningBlocks(provider, model);
  if (!model) {
    return {
      ...DEFAULT_PUSH_CAPABILITY_PROFILE,
      toolCalling: 'none',
      contentBlocks,
      reasoningBlocks,
      context: 'small',
    };
  }

  const capabilities = getModelCapabilities(provider, model);
  const nativeToolCalling = modelSupportsNativeToolCalling(provider, model);
  return {
    toolCalling: nativeToolCalling ? 'native' : 'json-text',
    streamingTools: nativeToolCalling,
    multimodal: modelSupportsMultimodal(provider, model, capabilities),
    structuredOutput: resolveStructuredOutputMode(provider, model),
    contentBlocks,
    reasoningBlocks,
    context: resolveContextTier(capabilities.contextLimit),
  };
}

export function providerModelSupportsNativeToolCalling(
  provider: string,
  modelId: string | undefined,
): boolean {
  return resolvePushCapabilityProfile(provider, modelId).toolCalling === 'native';
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

/** Sort catalog ids into the picker's canonical Cloudflare ordering. */
function sortCloudflareCatalogIds(models: CloudflareCatalogModel[]): string[] {
  return models
    .map((model) => model.id)
    .sort((left, right) => compareProviderModelIds('cloudflare', left, right));
}

export async function fetchCloudflareModels(opts: { force?: boolean } = {}): Promise<string[]> {
  // Cache-first: the binding catalog (list + capability flags) is cached in
  // localStorage with a 12h TTL, so the auto-fetch on every fresh page load
  // returns from cache instead of hitting `env.AI.models()` through the Worker.
  // The picker's manual refresh passes `force` to revalidate. The capability
  // gates read this same cache synchronously (see getCloudflareModelCapabilities).
  if (!opts.force) {
    const cached = readCloudflareCatalogCache();
    if (cached && cached.length > 0) return sortCloudflareCatalogIds(cached);
  }

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
    // `/api/cloudflare/models` returns the enriched catalog (`{ id,
    // functionCalling }[]`); `parseCloudflareCatalogPayload` also tolerates a
    // bare `string[]`. We avoid `normalizeModelList` because the CF binding's
    // own catalog pairs a UUID `id` with the `@cf/...` `name`, and the shared
    // normalizer would wrongly treat both as selectable ids.
    const catalog = parseCloudflareCatalogPayload(payload);
    if (catalog.length > 0) writeCloudflareCatalogCache(catalog);
    const liveModels = sortCloudflareCatalogIds(catalog);
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

export async function fetchSakanaModels(): Promise<string[]> {
  const key = getSakanaKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.sakana.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Sakana AI model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('sakana', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Sakana AI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchDeepSeekModels(): Promise<string[]> {
  const key = getDeepSeekKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.deepseek.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`DeepSeek model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('deepseek', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `DeepSeek model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
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
