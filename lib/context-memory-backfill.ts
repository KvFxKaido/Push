/**
 * One-shot backfill of embeddings for records that don't have one.
 *
 * Records written before the embedder existed — or during a model warmup
 * window, where the local provider returns lexical-now (see
 * `cli/embedding-provider-local.ts`) — persist without an `embedding`. They get
 * lexical-only retrieval until rewritten. This re-embeds them in place so they
 * gain semantic recall without waiting to be touched again.
 *
 * Scope (per the #824 follow-up decision): missing embeddings ONLY. Records that
 * already carry a vector are left alone, even if produced by a different model —
 * re-embedding those would churn on every provider switch. The selection is a
 * plain `!record.embedding` so the pass is idempotent: run it twice and the
 * second run finds nothing to do.
 */

import type { ContextMemoryStore } from './context-memory-store.js';
import { memoryRecordEmbeddingText, type EmbeddingProvider } from './embedding-provider.js';
import type { MemoryRecord } from './runtime-contract.js';

const DEFAULT_BATCH_SIZE = 32;

export interface BackfillOptions {
  /** Embed in batches of this size (one provider call each). */
  batchSize?: number;
  /** Optional record filter, e.g. scope to a repo/branch. */
  filter?: (record: MemoryRecord) => boolean;
  /** Progress callback after each batch: (embedded so far, total needing embed). */
  onProgress?: (embedded: number, total: number) => void;
}

export interface BackfillResult {
  /** Records considered (after `filter`). */
  scanned: number;
  /** Records missing an embedding (the backfill candidates). */
  needed: number;
  /** Records successfully embedded and written back. */
  embedded: number;
  /** Candidates the provider couldn't embed (returned null). */
  failed: number;
  /** Whether the provider was ready; false short-circuits the run. */
  providerReady: boolean;
}

export async function backfillEmbeddings(
  store: ContextMemoryStore,
  provider: EmbeddingProvider,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const all = await store.list(options.filter);
  const scanned = all.length;
  const needing = all.filter((record) => !record.embedding);
  const needed = needing.length;

  if (needed === 0) {
    return { scanned, needed: 0, embedded: 0, failed: 0, providerReady: true };
  }

  // Block until the provider can actually embed. Without this, a non-blocking
  // local provider that's still loading would return all-null and the whole
  // backfill would "fail" every record — exactly the case backfill exists to
  // fix. Always-ready providers omit warmup and are treated as ready.
  const providerReady = provider.warmup ? await provider.warmup() : true;
  if (!providerReady) {
    return { scanned, needed, embedded: 0, failed: needed, providerReady: false };
  }

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < needing.length; i += batchSize) {
    const batch = needing.slice(i, i + batchSize);
    const results = await provider.embed(batch.map(memoryRecordEmbeddingText));
    await Promise.all(
      batch.map(async (record, j) => {
        const vector = results[j]?.vector;
        if (!vector) {
          failed++;
          return;
        }
        await store.update(record.id, {
          embedding: vector,
          embeddingModel: results[j]?.model ?? provider.model,
        });
        embedded++;
      }),
    );
    options.onProgress?.(embedded, needed);
  }

  return { scanned, needed, embedded, failed, providerReady: true };
}
