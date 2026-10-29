/**
 * Artifact-scope resolver.
 *
 * Builds and parses storage keys for the artifact store. Scoping rules
 * mirror `MemoryScope` (see `lib/runtime-contract.ts`): the durable
 * identity is `repoFullName + branch`, with `chatId` as an optional
 * grouping layer below it.
 *
 * The resolver lives in `lib/` so both surfaces share one definition —
 * the same antipattern that motivated `lib/role-memory-budgets.ts` would
 * otherwise reappear here. CLI callers (no `chatId`) hit the same key
 * shape as web callers (with `chatId`); retrieval falls back from the
 * narrowest scope to the widest.
 *
 * Key shape is stable string-encoded so it can be used directly as a KV
 * prefix, a SQLite primary key, or a path segment under a Cloudflare
 * Artifacts repo. `/` is the only delimiter; embedded `/` characters in
 * `repoFullName` (always `owner/repo`) are tolerated because the encoded
 * key has a fixed component count.
 */

import type { ArtifactScope } from './types.js';

/**
 * Build a hierarchical scope key.
 *
 * Returns three keys at decreasing specificity so the store can search
 * from narrowest to widest. Callers list/get against `chatScopeKey()`
 * first, then fall back to `branchScopeKey()` when a CLI run has no
 * `chatId` to anchor on.
 */
export interface ArtifactScopeKeys {
  /** `artifact:<repo>:<branch>:<chatId>` — most specific, web-shaped. */
  chat: string | null;
  /** `artifact:<repo>:<branch>` — durable, survives CLI restarts. */
  branch: string;
  /** `artifact:<repo>` — repo-wide; used by cross-branch listings. */
  repo: string;
}

const PREFIX = 'artifact';
const BRANCH_NULL_SENTINEL = '_no_branch';

/**
 * Encode a scope into hierarchical lookup keys.
 *
 * Components are URI-encoded so `/` inside `repoFullName` (always
 * `owner/repo`) and any unusual branch names round-trip cleanly through
 * KV/SQLite/path-segment encodings.
 */
export function buildScopeKeys(scope: ArtifactScope): ArtifactScopeKeys {
  const repo = encodeURIComponent(scope.repoFullName);
  const branch = encodeURIComponent(scope.branch ?? BRANCH_NULL_SENTINEL);
  const chat = scope.chatId ? encodeURIComponent(scope.chatId) : null;

  return {
    repo: `${PREFIX}:${repo}`,
    branch: `${PREFIX}:${repo}:${branch}`,
    chat: chat ? `${PREFIX}:${repo}:${branch}:${chat}` : null,
  };
}

/**
 * The single primary key under which a new artifact is filed.
 *
 * Web callers always file under the chat-scoped key. CLI callers (no
 * `chatId`) file under the branch-scoped key. Retrieval is the inverse:
 * walk from chat → branch → repo until a match is found.
 */
export function primaryStorageKey(scope: ArtifactScope, artifactId: string): string {
  const keys = buildScopeKeys(scope);
  const parent = keys.chat ?? keys.branch;
  return `${parent}:${artifactId}`;
}

/**
 * Compare two scopes for "would-list-the-same-thing" equality.
 *
 * Used by clients deciding whether a cached artifact list is still valid
 * for the active scope. Treats undefined `chatId` and explicit
 * `chatId: undefined` as equivalent.
 */
export function scopesMatchForListing(a: ArtifactScope, b: ArtifactScope): boolean {
  return (
    a.repoFullName === b.repoFullName &&
    (a.branch ?? null) === (b.branch ?? null) &&
    (a.chatId ?? null) === (b.chatId ?? null)
  );
}
