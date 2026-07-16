/**
 * provider-input.ts — pushd provider/model input normalization.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Pure
 * string normalization; no daemon runtime state.
 */
export function normalizeProviderInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}
