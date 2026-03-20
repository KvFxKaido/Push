export function shouldAutoFetchProviderModels(params: {
  hasKey: boolean;
  modelCount: number;
  loading: boolean;
  error: string | null;
}): boolean {
  return params.hasKey && params.modelCount === 0 && !params.loading && !params.error;
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
  if (isActive) { fn(); return; }

  if (typeof requestIdleCallback !== 'undefined') {
    const id = requestIdleCallback(() => fn(), { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }

  const id = window.setTimeout(fn, 500);
  return () => window.clearTimeout(id);
}
