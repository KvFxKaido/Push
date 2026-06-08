/**
 * Embedding capability for semantic memory retrieval.
 *
 * This module is the single source of truth for everything embeddings-related
 * that crosses the web/CLI boundary:
 *
 *  - the `/api/memory/embed` request/response envelope (consumed by the web
 *    and CLI providers, produced by the Worker handler),
 *  - the model identifier that stamps each vector (cosine is only valid
 *    between same-model vectors),
 *  - the pure math (`cosineSimilarity`) and the text-selection rule
 *    (`memoryRecordEmbeddingText`) shared by the write and retrieval paths.
 *
 * The provider itself is injected like the memory store: a process-wide
 * default that each surface sets at bootstrap. When no provider is configured
 * (e.g. a fully-offline CLI run), every path degrades to pure lexical
 * retrieval — embeddings are strictly additive, never required.
 */

import type { MemoryRecord } from './runtime-contract.js';

/**
 * Workers AI BGE base model — 768-dim, English, normalized output. Stamped
 * onto every vector as `embeddingModel` so a future model swap can't silently
 * produce incomparable cosine scores: retrieval skips the semantic signal when
 * the query model and record model disagree.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;

/** Request body for `POST /api/memory/embed`. */
export interface EmbedRequest {
  texts: string[];
}

/**
 * Response body for `POST /api/memory/embed`. `vectors[i]` corresponds to
 * `texts[i]`; an individual entry is `null` when that text could not be
 * embedded (empty after trim, upstream error for that item). `model` lets the
 * caller stamp `embeddingModel` without hard-coding the constant on every
 * surface.
 */
export interface EmbedResponse {
  model: string;
  vectors: (number[] | null)[];
}

export interface EmbedResult {
  model: string;
  vector: number[] | null;
}

/**
 * A source of embeddings. Implementations live per-surface (Worker-backed HTTP
 * on web/CLI). `embed` MUST return one entry per input text, in order, using
 * `null` for any text it could not embed — never a shorter array.
 */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult[]>;
  /**
   * Optional: block until the provider is ready to embed, returning whether it
   * is. Providers whose `embed` is non-blocking-while-warming (e.g. the local
   * on-device model) implement this so deliberate, user-initiated batch work
   * like backfill can wait for the model rather than getting all-null. Always-
   * ready providers (remote HTTP) omit it; callers treat that as ready.
   */
  warmup?(): Promise<boolean>;
}

let defaultProvider: EmbeddingProvider | null = null;

export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
  return defaultProvider;
}

export function setDefaultEmbeddingProvider(provider: EmbeddingProvider | null): void {
  defaultProvider = provider;
}

/**
 * Embed a single text via the default provider, or `null` when no provider is
 * configured or the provider could not embed it. Best-effort: never throws on
 * provider failure — callers treat `null` as "fall back to lexical".
 */
export async function embedOne(
  text: string,
  provider: EmbeddingProvider | null = defaultProvider,
): Promise<EmbedResult | null> {
  if (!provider) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const [result] = await provider.embed([trimmed]);
    if (!result || !result.vector) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Build the text Push embeds for a record. Intentionally the same field set
 * the lexical scorer's `countTaskTokenOverlap` haystack draws from, so the two
 * signals stay aligned on what a record "is about".
 */
export function memoryRecordEmbeddingText(record: MemoryRecord): string {
  return [
    record.summary,
    record.detail,
    ...(record.tags ?? []),
    record.source.label,
    ...(record.relatedFiles ?? []),
    ...(record.relatedSymbols ?? []),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
    .trim();
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for missing, length-mismatched, or
 * zero-magnitude vectors — i.e. "no usable semantic signal", which the scorer
 * treats the same as having no embedding at all.
 */
export function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
