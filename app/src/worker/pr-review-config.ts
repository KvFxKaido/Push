/**
 * Runtime on/off flag for the autonomous PR reviewer.
 *
 * Stored as a single KV key in `SNAPSHOT_INDEX` (reused as a general worker KV —
 * one clearly-namespaced config key, no new binding to provision so the in-app
 * toggle works immediately). Read by the GitHub webhook *before* it enqueues a
 * review: when disabled, no Durable Object spins up and no provider tokens are
 * spent — the point of the toggle. Also read/written by the `/api/pr-reviews/
 * config` endpoint behind the in-app switch.
 *
 * Defaults to ENABLED when the flag is unset, the KV binding is absent, or a
 * read fails — fail-open, so a fresh deploy reviews by default and a transient
 * KV hiccup never silently turns reviews off. (A persisted `0` is read back
 * reliably; fail-open only applies to genuine binding/outage cases.)
 */

import type { Env } from './worker-middleware';

const CONFIG_KEY = 'config:pr-review-enabled';

export async function isPrReviewEnabled(env: Env): Promise<boolean> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return true;
  try {
    const value = await kv.get(CONFIG_KEY);
    return value !== '0';
  } catch {
    return true;
  }
}

/**
 * Persist the flag. Returns false when there's no KV binding to write to (the
 * caller surfaces that as NOT_CONFIGURED rather than silently no-op'ing).
 */
export async function setPrReviewEnabled(env: Env, enabled: boolean): Promise<boolean> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) return false;
  await kv.put(CONFIG_KEY, enabled ? '1' : '0');
  return true;
}
