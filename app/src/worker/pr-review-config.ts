/**
 * Runtime config for the autonomous PR reviewer.
 *
 * Stored in the unified settings document (`settings:<ownerId>`, see
 * settings-config.ts) under the `reviewer.autonomous.*` keys — the storage
 * substrate folded in by the Settings Unification work. The webhook/DO read
 * path has no user session, so the document is resolved by `resolveOwnerUserId`
 * (the single-user deployment owner), which is the same identity the in-app
 * controls resolve to. This replaces the former *global* flat KV keys; those are
 * still read as a fallback so a pre-unification deployment keeps its config.
 *
 *   - enabled flag: read before webhook enqueue, so disabled reviews spend no quota
 *   - provider/model: read by the Durable Object immediately before model execution
 *
 * Enabled defaults to true when unset / unavailable (fail-open so fresh deploys
 * review by default). Provider/model default to the built-in Anthropic reviewer
 * unless overridden by the doc, the legacy flat keys, or the Worker env vars
 * (precedence: doc → legacy KV → env → built-in default).
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  SHARED_PROVIDER_DEFAULT_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
} from '@push/lib/provider-models';
import { readSettingsDoc, resolveOwnerUserId, writeSettingsMerge } from './settings-config';
import type { Env } from './worker-middleware';

// Canonical keys inside the unified settings document. The autonomous reviewer
// and the in-app advisory reviewer are co-located here but kept as distinct
// blocks (`reviewer.autonomous.*` vs `reviewer.advisory.*`) — same document,
// separate features (runbook open question #1).
const ENABLED_DOC_KEY = 'reviewer.autonomous.enabled';
const PROVIDER_DOC_KEY = 'reviewer.autonomous.provider';
const MODEL_DOC_KEY = 'reviewer.autonomous.model';

// Pre-unification global flat keys. Read-only fallback so an existing deployment
// doesn't lose its reviewer config on the first deploy after this lands; new
// writes go to the document above.
const LEGACY_ENABLED_KEY = 'config:pr-review-enabled';
const LEGACY_PROVIDER_KEY = 'config:pr-review-provider';
const LEGACY_MODEL_KEY = 'config:pr-review-model';

export const DEFAULT_PR_REVIEW_PROVIDER: AIProviderType = 'anthropic';
export const DEFAULT_PR_REVIEW_MODEL = ANTHROPIC_DEFAULT_MODEL;

const PR_REVIEW_MODEL_CATALOG: Partial<Record<AIProviderType, readonly string[]>> = {
  ...SHARED_PROVIDER_MODEL_CATALOG,
  cloudflare: CLOUDFLARE_MODELS,
};

const PR_REVIEW_DEFAULT_MODELS: Partial<Record<AIProviderType, string>> = {
  ...SHARED_PROVIDER_DEFAULT_MODELS,
  cloudflare: CLOUDFLARE_DEFAULT_MODEL,
};

export interface PrReviewRuntimeConfig {
  provider?: AIProviderType;
  model?: string;
}

export interface PrReviewEffectiveConfig {
  enabled: boolean;
  provider: AIProviderType;
  model: string;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getPrReviewModelOptions(provider: string): readonly string[] {
  return PR_REVIEW_MODEL_CATALOG[provider as AIProviderType] ?? [];
}

export function getDefaultPrReviewModel(provider: AIProviderType): string | undefined {
  return PR_REVIEW_DEFAULT_MODELS[provider];
}

export function isKnownPrReviewProvider(provider: string): provider is AIProviderType {
  return getPrReviewModelOptions(provider).length > 0;
}

export function isValidPrReviewRuntimeConfig(provider: string, model: string): boolean {
  return getPrReviewModelOptions(provider).includes(model);
}

export async function isPrReviewEnabled(env: Env): Promise<boolean> {
  const doc = await readSettingsDoc(env, resolveOwnerUserId(env));
  const docVal = doc.values[ENABLED_DOC_KEY];
  if (typeof docVal === 'boolean') return docVal;

  // Legacy flat-key fallback. Fail open (enabled) on a missing binding or read
  // error so a fresh / degraded deploy still reviews by default.
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return true;
  try {
    const value = await kv.get(LEGACY_ENABLED_KEY);
    return value !== '0';
  } catch {
    return true;
  }
}

/**
 * Resolve provider/model overrides. Precedence is doc → legacy KV → env →
 * default; invalid values are intentionally returned as-is so the executor can
 * hard-fail with an auditable configuration error instead of silently falling
 * back.
 */
export async function getPrReviewRuntimeConfig(env: Env): Promise<PrReviewRuntimeConfig> {
  let provider = clean(env.PR_REVIEW_PROVIDER);
  let model = clean(env.PR_REVIEW_MODEL);

  // Legacy flat keys override env (pre-unification behaviour preserved).
  const kv = env.SNAPSHOT_INDEX;
  if (kv) {
    try {
      const [legacyProvider, legacyModel] = await Promise.all([
        kv.get(LEGACY_PROVIDER_KEY),
        kv.get(LEGACY_MODEL_KEY),
      ]);
      provider = clean(legacyProvider) ?? provider;
      model = clean(legacyModel) ?? model;
    } catch {
      // Keep env/default fallback on transient KV failures.
    }
  }

  // The unified document is the newest source and wins over everything below.
  const doc = await readSettingsDoc(env, resolveOwnerUserId(env));
  const docProvider = doc.values[PROVIDER_DOC_KEY];
  const docModel = doc.values[MODEL_DOC_KEY];
  if (typeof docProvider === 'string') provider = clean(docProvider) ?? provider;
  if (typeof docModel === 'string') model = clean(docModel) ?? model;

  return {
    ...(provider ? { provider: provider as AIProviderType } : null),
    ...(model ? { model } : null),
  };
}

export async function getPrReviewEffectiveConfig(env: Env): Promise<PrReviewEffectiveConfig> {
  const [enabled, runtime] = await Promise.all([
    isPrReviewEnabled(env),
    getPrReviewRuntimeConfig(env),
  ]);
  const provider = runtime.provider ?? DEFAULT_PR_REVIEW_PROVIDER;
  const model = runtime.model ?? getDefaultPrReviewModel(provider) ?? DEFAULT_PR_REVIEW_MODEL;
  return { enabled, provider, model };
}

/**
 * Persist the flag into the owner's settings document. Returns false when
 * there's no KV binding to write to (the caller surfaces that as NOT_CONFIGURED
 * rather than silently no-op'ing).
 */
export async function setPrReviewEnabled(env: Env, enabled: boolean): Promise<boolean> {
  const result = await writeSettingsMerge(env, resolveOwnerUserId(env), {
    [ENABLED_DOC_KEY]: enabled,
  });
  return result.ok;
}

/** Persist the automated reviewer provider/model pair into the settings doc. */
export async function setPrReviewRuntimeConfig(
  env: Env,
  provider: AIProviderType,
  model: string,
): Promise<boolean> {
  const result = await writeSettingsMerge(env, resolveOwnerUserId(env), {
    [PROVIDER_DOC_KEY]: provider,
    [MODEL_DOC_KEY]: model,
  });
  return result.ok;
}
