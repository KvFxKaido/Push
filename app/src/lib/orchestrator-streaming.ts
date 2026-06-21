import { extractProviderErrorDetail } from './provider-error-utils';
export type { ChunkMetadata, StreamUsage } from '@push/lib/provider-contract';
import type { ChunkMetadata } from '@push/lib/provider-contract';

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

// ---------------------------------------------------------------------------
// Smart Chunking — reduces UI updates on mobile by batching tokens
// ---------------------------------------------------------------------------

/**
 * Creates a chunked emitter that batches tokens for smoother mobile UI.
 *
 * Tokens are buffered and emitted when:
 * 1. A word boundary (space/newline) is encountered
 * 2. Buffer reaches MIN_CHUNK_SIZE characters
 * 3. FLUSH_INTERVAL_MS passes without emission
 */
export interface ChunkedEmitter {
  push(token: string): void;
  flush(): void;
}

export function createChunkedEmitter(
  emit: (chunk: string, meta?: ChunkMetadata) => void,
  options?: { minChunkSize?: number; flushIntervalMs?: number },
): ChunkedEmitter {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4;
  const FLUSH_INTERVAL_MS = options?.flushIntervalMs ?? 50;

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chunkIndex = 0;

  const doEmit = () => {
    if (buffer) {
      chunkIndex++;
      emit(buffer, { chunkIndex });
      buffer = '';
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(doEmit, FLUSH_INTERVAL_MS);
    }
  };

  return {
    push(token: string) {
      buffer += token;

      const hasWordBoundary = /[\s\n]/.test(token);
      if (hasWordBoundary && buffer.length >= MIN_CHUNK_SIZE) {
        doEmit();
        return;
      }

      if (buffer.length >= MIN_CHUNK_SIZE * 4) {
        doEmit();
        return;
      }

      scheduleFlush();
    },

    flush() {
      doEmit();
    },
  };
}
