// Synchronous, process-local cache of GitHub repo metadata that the thinking-
// phase vibe picker needs but can't fetch in its hot path. Mirrors the shape of
// `getSandboxEnvironment` (a sync cache keyed by a durable id): `useRepos`
// populates it when it lists repositories, and the round loop reads it by
// `full_name` to classify a repo's vibe without an async GitHub call.
//
// Keyed by `full_name` (a durable `owner/repo` identifier) rather than a
// per-session id, per the cross-surface storage guidance — so a later CLI
// surface could populate the same cache from its own repo listing.

export interface RepoMetadata {
  /** GitHub repository topics, already lowercase-hyphenated, e.g. `['machine-learning']`. */
  topics: string[];
  /** GitHub's primary-language field, e.g. `'TypeScript'`. */
  language: string | null;
}

const cache = new Map<string, RepoMetadata>();

function normalizeKey(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export function setRepoMetadata(fullName: string, meta: RepoMetadata): void {
  if (!fullName) return;
  cache.set(normalizeKey(fullName), meta);
}

export function getRepoMetadata(fullName: string | null | undefined): RepoMetadata | null {
  if (!fullName) return null;
  return cache.get(normalizeKey(fullName)) ?? null;
}

/** Test-only: drop all cached metadata so suites don't leak state into each other. */
export function clearRepoMetadataCache(): void {
  cache.clear();
}
