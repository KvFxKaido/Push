/**
 * Runtime config for the autonomous PR reviewer.
 *
 * Stored in clearly-namespaced KV keys under `SNAPSHOT_INDEX` (reused as a
 * general worker KV so the in-app controls need no new binding):
 *   - enabled flag: read before webhook enqueue, so disabled reviews spend no quota
 *   - provider/model: read by the Durable Object immediately before model execution
 *
 * Enabled defaults to true when unset / unavailable (fail-open so fresh deploys
 * review by default). Provider/model default to the built-in Anthropic reviewer
 * unless overridden by KV or the legacy Worker env vars.
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  SHARED_PROVIDER_DEFAULT_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
} from '@push/lib/provider-models';
import type { Env } from './worker-middleware';

const ENABLED_CONFIG_KEY = 'config:pr-review-enabled';
const PROVIDER_CONFIG_KEY = 'config:pr-review-provider';
const MODEL_CONFIG_KEY = 'config:pr-review-model';

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
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return true;
  try {
    const value = await kv.get(ENABLED_CONFIG_KEY);
    return value !== '0';
  } catch {
    return true;
  }
}

/**
 * Resolve provider/model overrides. KV wins over env vars; invalid values are
 * intentionally returned as-is so the executor can hard-fail with an auditable
 * configuration error instead of silently falling back.
 */
export async function getPrReviewRuntimeConfig(env: Env): Promise<PrReviewRuntimeConfig> {
  let provider = clean(env.PR_REVIEW_PROVIDER);
  let model = clean(env.PR_REVIEW_MODEL);

  const kv = env.SNAPSHOT_INDEX;
  if (kv) {
    try {
      const [storedProvider, storedModel] = await Promise.all([
        kv.get(PROVIDER_CONFIG_KEY),
        kv.get(MODEL_CONFIG_KEY),
      ]);
      provider = clean(storedProvider) ?? provider;
      model = clean(storedModel) ?? model;
    } catch {
      // Keep env/default fallback on transient KV failures.
    }
  }

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
 * Persist the flag. Returns false when there's no KV binding to write to (the
 * caller surfaces that as NOT_CONFIGURED rather than silently no-op'ing).
 */
export async function setPrReviewEnabled(env: Env, enabled: boolean): Promise<boolean> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return false;
  await kv.put(ENABLED_CONFIG_KEY, enabled ? '1' : '0');
  return true;
}

/** Persist the automated reviewer provider/model pair. */
export async function setPrReviewRuntimeConfig(
  env: Env,
  provider: AIProviderType,
  model: string,
): Promise<boolean> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return false;
  try {
    await Promise.all([kv.put(PROVIDER_CONFIG_KEY, provider), kv.put(MODEL_CONFIG_KEY, model)]);
    return true;
  } catch {
    return false;
  }
}
