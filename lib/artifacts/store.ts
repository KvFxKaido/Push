/**
 * Cross-surface artifact-store interface.
 *
 * Surfaces implement this against their own persistence: the CLI uses
 * flat JSON under `~/.push/artifacts/`, the web Worker uses Workers KV
 * (or D1 if listing pressure shows up). The `lib/` interface keeps the
 * tool handler portable — the same `buildArtifactRecord` output flows
 * into either backend without per-surface branching.
 *
 * Listing semantics: `list()` returns artifacts ordered newest-first
 * (`updatedAt` descending). Implementations that can't serve that
 * order natively must sort in memory before returning. Callers expect
 * the order; the renderer relies on it.
 *
 * Scope semantics: `list({ scope })` returns the most-specific match
 * available — a chat-scoped query falls back to branch-scoped results
 * only when the implementation explicitly opts in, NOT silently. The
 * default behavior is "exact scope only," which matches what callers
 * usually want.
 */

import type { ArtifactRecord, ArtifactScope } from './types.js';

/** Read-side query against the store. */
export interface ListArtifactsQuery {
  scope: ArtifactScope;
  /** Optional kind filter; when omitted, all kinds are returned. */
  kind?: ArtifactRecord['kind'] | ArtifactRecord['kind'][];
  /** Soft cap on results; implementations may return fewer. */
  limit?: number;
}

export interface ArtifactStore {
  /** Fetch a single artifact by id within its scope. Returns null when missing. */
  get(scope: ArtifactScope, id: string): Promise<ArtifactRecord | null>;

  /** List artifacts under a scope. Newest-first. */
  list(query: ListArtifactsQuery): Promise<ArtifactRecord[]>;

  /**
   * Insert or replace an artifact. Implementations key persistence off
   * `record.scope`; callers must not mutate `record.scope` after
   * construction or a subsequent `get`/`list` against the original
   * scope will miss the record.
   */
  put(record: ArtifactRecord): Promise<void>;

  /** Delete an artifact by id within its scope. No-op when missing. */
  delete(scope: ArtifactScope, id: string): Promise<void>;
}
