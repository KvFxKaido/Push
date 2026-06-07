import { describe, expect, it } from 'vitest';
import type { Env } from './worker-middleware';
import {
  evictInflightReview,
  listInflightReviews,
  recordInflightReview,
  repoIndexPrefix,
} from './pr-review-inflight-index';

function kvEnv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const env = {
    SNAPSHOT_INDEX: {
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
      get: async (k: string) => store.get(k) ?? null,
      delete: async (k: string) => {
        store.delete(k);
      },
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      }),
    },
  } as unknown as Env;
  return { env, store };
}

const entry = (prNumber: number, deliveryId: string, createdAt: number) => ({
  repo: 'octo/repo',
  prNumber,
  deliveryId,
  headSha: 'sha',
  createdAt,
});

describe('pr-review-inflight-index', () => {
  it('records, lists newest-first, and scopes by repo prefix', async () => {
    const { env, store } = kvEnv();
    await recordInflightReview(env, entry(7, 'a', 1));
    await recordInflightReview(env, entry(8, 'b', 3));
    await recordInflightReview(env, entry(9, 'c', 2));
    // Different repo — must not appear under octo/repo.
    await recordInflightReview(env, { ...entry(1, 'd', 9), repo: 'other/repo' });

    expect(store.has('inflight:pr-review:octo/repo#7#a')).toBe(true);

    const listed = await listInflightReviews(env, 'octo/repo');
    expect(listed.map((e) => e.deliveryId)).toEqual(['b', 'c', 'a']);
    expect(listed.every((e) => e.repo === 'octo/repo')).toBe(true);
  });

  it('evicts a specific entry', async () => {
    const { env } = kvEnv();
    await recordInflightReview(env, entry(7, 'a', 1));
    await recordInflightReview(env, entry(8, 'b', 2));
    await evictInflightReview(env, 'octo/repo', 7, 'a');
    const listed = await listInflightReviews(env, 'octo/repo');
    expect(listed.map((e) => e.deliveryId)).toEqual(['b']);
  });

  it('drops malformed JSON entries from the listing', async () => {
    const { env } = kvEnv({
      [`${repoIndexPrefix('octo/repo')}7#good`]: JSON.stringify(entry(7, 'good', 1)),
      [`${repoIndexPrefix('octo/repo')}7#bad`]: '{ not json',
      [`${repoIndexPrefix('octo/repo')}7#partial`]: JSON.stringify({ repo: 'octo/repo' }),
    });
    const listed = await listInflightReviews(env, 'octo/repo');
    expect(listed.map((e) => e.deliveryId)).toEqual(['good']);
  });

  it('is a no-op (no throw, empty list) without a KV binding', async () => {
    const env = {} as Env;
    await expect(recordInflightReview(env, entry(7, 'a', 1))).resolves.toBeUndefined();
    await expect(evictInflightReview(env, 'octo/repo', 7, 'a')).resolves.toBeUndefined();
    await expect(listInflightReviews(env, 'octo/repo')).resolves.toEqual([]);
  });
});
