import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZaiKey } from '@/hooks/useZaiConfig';
import { getKimiKey } from '@/hooks/useKimiConfig';
import { getHuggingFaceKey } from '@/hooks/useHuggingFaceConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { getXAIKey } from '@/hooks/useXAIConfig';
import { safeStorageGet, safeStorageSet } from './safe-storage';
import {
  ANTHROPIC_MODELS,
  CLOUDFLARE_MODELS,
  compareProviderModelIds,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  NVIDIA_MODELS,
  OPENROUTER_MODELS,
  PROVIDER_URLS,
  SAKANA_MODELS,
  XAI_MODELS,
  ZEN_GO_MODELS,
  ZEN_MODELS,
} from './providers';
import { asRecord } from './utils';
import {
  MIN_PUSH_CONTEXT_TOKENS,
  resolvePushCapabilityProfile as resolveSharedPushCapabilityProfile,
  type PushCapabilityProfileOptions,
  type PushModelCapabilityMetadata,
} from '@push/lib/capability-profile';
import type { PushCapabilityProfile } from './capabilities';
import { lookupDeclaredModelMetadata, type DeclaredModelMetadata } from '@push/lib/model-metadata';

export type { PushCapabilityProfileOptions } from '@push/lib/capability-profile';

const MODELS_FETCH_TIMEOUT_MS = 12_000;
const MODELS_DEV_OPENROUTER_URL = 'https://models.dev/api.json';
const MODELS_DEV_OPENROUTER_CACHE_KEY = 'push:models-dev:openrouter-models';
const MODELS_DEV_NVIDIA_CACHE_KEY = 'push:models-dev:nvidia-models';
const MODELS_DEV_OLLAMA_CACHE_KEY = 'push:models-dev:ollama-cloud-models';
const MODELS_DEV_OPENCODE_CACHE_KEY = 'push:models-dev:opencode-models';
const MODELS_DEV_HUGGINGFACE_CACHE_KEY = 'push:models-dev:huggingface-models';
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
export const MIN_CONTEXT_TOKENS = MIN_PUSH_CONTEXT_TOKENS;
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
          : provider === 'huggingface'
            ? MODELS_DEV_HUGGINGFACE_CACHE_KEY
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

// These providers intentionally use their surface catalog as native-tool
// evidence rather than trusting incomplete/free-text models.dev metadata.
// Zen is the cautionary case for why: its default `big-pickle` is a
// Zen-proprietary id that isn't in models.dev at all, and the `opencode`
// block can't be verified to populate `tool_call` for the bare ids — a
// capability gate would silently leave native FC off for the default and any
// uncovered model. The curated catalog IS the allowlist; adding a model to
// `lib/provider-models.ts` opts it in, keeping the gate in lockstep with
// catalog refreshes.
const WEB_CURATED_NATIVE_TOOL_MODELS: Readonly<Record<string, ReadonlySet<string>>> = {
  anthropic: new Set(ANTHROPIC_MODELS),
  fireworks: new Set(FIREWORKS_MODELS),
  google: new Set(GOOGLE_MODELS),
  sakana: new Set(SAKANA_MODELS),
  xai: new Set(XAI_MODELS),
  zen: new Set([...ZEN_MODELS, ...ZEN_GO_MODELS]),
};

function lookupWebPushCapabilityMetadata(
  provider: string,
  modelId: string,
): PushModelCapabilityMetadata {
  if (provider === 'cloudflare') {
    const cloudflare = getCloudflareModelCapabilities(modelId);
    return cloudflare
      ? {
          toolCall: cloudflare.functionCalling,
          structuredOutput: cloudflare.functionCalling,
        }
      : {};
  }

  const capabilities = getModelCapabilities(provider, modelId);
  const curatedNativeTools = WEB_CURATED_NATIVE_TOOL_MODELS[provider];
  return {
    toolCall: curatedNativeTools?.has(modelId) ?? capabilities.toolCall,
    vision: capabilities.vision,
    structuredOutput: capabilities.structuredOutput,
    contextLimit: capabilities.contextLimit,
  };
}

export function resolvePushCapabilityProfile(
  provider: string,
  modelId: string | undefined,
  options?: PushCapabilityProfileOptions,
): PushCapabilityProfile {
  return resolveSharedPushCapabilityProfile(
    provider,
    modelId,
    lookupWebPushCapabilityMetadata,
    options,
  );
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

async function fetchModelsDevHuggingFaceMetadata(
  forceRefresh = false,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata(
    'huggingface',
    MODELS_DEV_HUGGINGFACE_CACHE_KEY,
    forceRefresh,
  );
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

export async function fetchZaiModels(): Promise<string[]> {
  const key = getZaiKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.zai.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Z.ai model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('zai', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Z.ai model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchKimiModels(): Promise<string[]> {
  const key = getKimiKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.kimi.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Kimi model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('kimi', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Kimi model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchHuggingFaceModels(
  opts: { forceMetadataRefresh?: boolean } = {},
): Promise<string[]> {
  const key = getHuggingFaceKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    // The metadata fetch warms the models.dev capability cache as a side
    // effect (read synchronously by getModelCapabilities); the picker list
    // itself stays the full live router catalog — models.dev covers only the
    // popular subset, so filtering to it would hide live models.
    const [res] = await Promise.all([
      fetch(PROVIDER_URLS.huggingface.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevHuggingFaceMetadata(opts.forceMetadataRefresh),
    ]);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Hugging Face model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('huggingface', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Hugging Face model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
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

export async function fetchXAIModels(): Promise<string[]> {
  const key = getXAIKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(PROVIDER_URLS.xai.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`xAI model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload).sort((left, right) =>
      compareProviderModelIds('xai', left, right),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `xAI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`,
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
