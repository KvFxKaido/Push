/**
 * Cross-PR discovery index for in-flight reviews.
 *
 * Each PR's reviews live in their own `PrReviewJob` DO (named `repo#pr`), and
 * Durable Objects can't be enumerated — so there's no way to ask "which PRs
 * have a review running right now?" without a side index. This is that index: a
 * thin set of KV keys, one per enqueued review, that the cross-PR view lists to
 * discover which DOs to ask for authoritative status.
 *
 * Stored in `SNAPSHOT_INDEX` (the same general-purpose worker KV the reviewer
 * config reuses), under a clearly-namespaced prefix:
 *
 *   inflight:pr-review:<repo>#<prNumber>#<deliveryId>  ->  InflightIndexEntry
 *
 * Lifecycle is deliberately write-once + self-healing rather than
 * write-then-delete-on-terminal:
 *   - **Write** happens once, at enqueue (the DO's single `handleStart`
 *     chokepoint covers both webhook and manual triggers).
 *   - **Cleanup** is lazy (the reader evicts an entry once its DO reports a
 *     terminal status) plus a TTL backstop (an entry whose DO died entirely
 *     just expires). We deliberately do NOT delete from the DO's many terminal
 *     paths (complete / fail / supersede / cancel / timeout) — five write sites
 *     is five chances to drift, and the TTL makes any leak transient anyway.
 *
 * Everything here is best-effort and guarded on the KV binding: the index is an
 * observability aid, never a correctness dependency. The DO's own per-PR state
 * remains the source of truth.
 */

import type { Env } from './worker-middleware';

const KEY_PREFIX = 'inflight:pr-review:';

/**
 * TTL for an index entry. Outlives the DO's hard review budget
 * (REVIEW_TIMEOUT_MS, 15 min) with margin so a live review is never evicted out
 * from under itself; an entry whose DO vanished self-expires shortly after.
 */
const INDEX_TTL_SECONDS = 20 * 60;

export interface InflightIndexEntry {
  repo: string;
  prNumber: number;
  deliveryId: string;
  headSha: string;
  createdAt: number;
}

function indexKey(repo: string, prNumber: number, deliveryId: string): string {
  return `${KEY_PREFIX}${repo}#${prNumber}#${deliveryId}`;
}

/** Prefix that lists every in-flight entry for one repo. */
export function repoIndexPrefix(repo: string): string {
  return `${KEY_PREFIX}${repo}#`;
}

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

/**
 * Register a freshly-enqueued review in the discovery index. Best-effort: a KV
 * hiccup (or absent binding) must never fail the enqueue, only cost the review
 * its appearance in the cross-PR view until the next one writes.
 */
export async function recordInflightReview(env: Env, entry: InflightIndexEntry): Promise<void> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return;
  try {
    await kv.put(indexKey(entry.repo, entry.prNumber, entry.deliveryId), JSON.stringify(entry), {
      expirationTtl: INDEX_TTL_SECONDS,
    });
  } catch (err) {
    log('warn', 'pr_review_inflight_index_write_failed', {
      repo: entry.repo,
      pr: entry.prNumber,
      deliveryId: entry.deliveryId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * List every in-flight index entry for a repo. Returns parsed entries
 * newest-first; silently drops malformed values. Empty (not throwing) when KV
 * is unbound or the list fails — the caller renders "nothing in flight".
 */
export async function listInflightReviews(env: Env, repo: string): Promise<InflightIndexEntry[]> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return [];
  let keys: { name: string }[];
  try {
    // In-flight reviews are few (each capped at 15 min) so a single page is
    // plenty; we don't paginate. The 1000-key default ceiling is unreachable.
    const listed = await kv.list({ prefix: repoIndexPrefix(repo) });
    keys = listed.keys;
  } catch (err) {
    log('warn', 'pr_review_inflight_index_list_failed', {
      repo,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const entries = await Promise.all(
    keys.map(async ({ name }) => {
      try {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<InflightIndexEntry>;
        if (
          typeof parsed.repo !== 'string' ||
          typeof parsed.prNumber !== 'number' ||
          typeof parsed.deliveryId !== 'string'
        ) {
          return null;
        }
        return {
          repo: parsed.repo,
          prNumber: parsed.prNumber,
          deliveryId: parsed.deliveryId,
          headSha: typeof parsed.headSha === 'string' ? parsed.headSha : '',
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
        } satisfies InflightIndexEntry;
      } catch {
        return null;
      }
    }),
  );

  return entries
    .filter((e): e is InflightIndexEntry => e !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop an index entry whose DO has reported a terminal status (or vanished).
 * Best-effort: a failed delete just leaves the entry for the TTL to reap.
 */
export async function evictInflightReview(
  env: Env,
  repo: string,
  prNumber: number,
  deliveryId: string,
): Promise<void> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return;
  try {
    await kv.delete(indexKey(repo, prNumber, deliveryId));
  } catch (err) {
    log('warn', 'pr_review_inflight_index_evict_failed', {
      repo,
      pr: prNumber,
      deliveryId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
