import type { ProviderCredentialSource } from '@/lib/provider-engine-capability';
import type { AIProviderType } from '@push/lib/provider-contract';

// These Worker routes can return a useful catalog without forwarding a
// provider credential. Some are genuinely public upstream catalogs; others
// deliberately return Push's curated fallback when no upstream key resolves.
// Keeping this distinction here prevents account-stored `user-key` provenance
// from enabling private model-list proxies that cannot read that key store.
const KEYLESS_MODEL_CATALOG_PROVIDERS: ReadonlySet<AIProviderType> = new Set([
  'ollama',
  'zai',
  'kimi',
  'huggingface',
  'zen',
  'openai',
  'xai',
  'google',
]);

export function canAccessProviderModelCatalog(params: {
  provider: AIProviderType;
  hasLocalKey: boolean;
  credentialSource: ProviderCredentialSource | null | undefined;
}): boolean {
  if (params.hasLocalKey) return true;
  if (!params.credentialSource) return false;
  if (KEYLESS_MODEL_CATALOG_PROVIDERS.has(params.provider)) return true;

  // Gateway BYOK and Worker secrets are directly consumable by every private
  // model-list proxy. An account-stored user key is only injected into durable
  // engine dispatch today, not foreground `/api/<provider>/models` requests.
  return (
    params.credentialSource === 'gateway-byok' ||
    params.credentialSource === 'worker-secret' ||
    params.credentialSource === 'binding'
  );
}

export function shouldAutoFetchProviderModels(params: {
  canFetch: boolean;
  modelCount: number;
  loading: boolean;
  error: string | null;
}): boolean {
  return params.canFetch && params.modelCount === 0 && !params.loading && !params.error;
}

/** Default backoff schedule for retrying a failed provider model-list fetch. */
export const MODELS_RETRY_BASE_MS = 3000;
export const MODELS_RETRY_CAP_MS = 30_000;
export const MODELS_RETRY_MAX_ATTEMPTS = 3;

/**
 * Backoff delay (ms) before the next retry of a failed model-list fetch, or
 * `null` once attempts are exhausted (stop retrying).
 *
 * `attempt` is the zero-based index of the retry about to be scheduled — i.e.
 * after the initial fetch fails you call `nextModelsRetryDelayMs(0)` to size
 * the first retry. Exponential (base · 2^attempt), clamped to `capMs`, capped at
 * `maxAttempts` retries. Without this, a single transient failure leaves
 * `shouldAutoFetchProviderModels` permanently false (the `!error` gate) and the
 * selector is pinned to its hardcoded fallback list for the rest of the session.
 */
export function nextModelsRetryDelayMs(
  attempt: number,
  opts?: { baseMs?: number; capMs?: number; maxAttempts?: number },
): number | null {
  const maxAttempts = opts?.maxAttempts ?? MODELS_RETRY_MAX_ATTEMPTS;
  if (attempt < 0 || attempt >= maxAttempts) return null;
  const baseMs = opts?.baseMs ?? MODELS_RETRY_BASE_MS;
  const capMs = opts?.capMs ?? MODELS_RETRY_CAP_MS;
  return Math.min(capMs, baseMs * 2 ** attempt);
}

/**
 * Schedule an auto-fetch: immediate for the active provider, deferred via
 * requestIdleCallback (or setTimeout fallback) for all others.
 * Returns a cleanup function to cancel the pending idle/timeout callback,
 * or undefined if no deferred work was scheduled.
 */
export function scheduleAutoFetch(
  shouldFetch: boolean,
  isActive: boolean,
  fn: () => void,
): (() => void) | undefined {
  if (!shouldFetch) return;
  if (isActive) {
    fn();
    return;
  }

  if (typeof requestIdleCallback !== 'undefined') {
    const id = requestIdleCallback(() => fn(), { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }

  const id = window.setTimeout(fn, 500);
  return () => window.clearTimeout(id);
}
