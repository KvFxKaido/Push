import { extractProviderErrorDetail } from './provider-error-utils';
export type { ChunkMetadata, StreamUsage } from '@push/lib/provider-contract';

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

export function parseProviderError(
  parsed: unknown,
  fallback: string,
  includeTopLevelMessage = false,
): string {
  return extractProviderErrorDetail(parsed, fallback, includeTopLevelMessage);
}
