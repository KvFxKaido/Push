import type { PushedDiffSource } from '@push/lib/git/pushed-diff-source';
import type { PushPlanSource, RemoteHeadRead } from '@push/lib/git/push-plan';
import type { NativeGitPlugin } from './definitions';

/**
 * Run a plugin read, mapping a thrown bridge/JGit failure to null — but log it
 * first. A caught throw is infrastructure trouble (bridge unavailable, a plugin
 * method missing on an older APK, a JGit error), which the pushed-diff gates
 * treat as fail-open; without this line it is indistinguishable from a
 * genuinely-empty push (`?? null`), so a push that shipped WITHOUT a secret
 * scan or Auditor audit would leave no trace. A normal empty/absent result
 * (`?? null`, no throw) is not logged — that's the expected quiet path.
 */
async function read<T>(op: string, task: () => Promise<T | null | undefined>): Promise<T | null> {
  try {
    return (await task()) ?? null;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'native_pushed_diff_read_failed',
        op,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

async function readRemoteHead(task: () => Promise<RemoteHeadRead>): Promise<RemoteHeadRead> {
  try {
    return await task();
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'native_pushed_diff_read_failed',
        op: 'lsRemoteHead',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: false, sha: null };
  }
}

export function pushedDiffSourceFromNativePlugin(
  plugin: NativeGitPlugin,
  dir: string,
): PushedDiffSource {
  return {
    currentBranch: () =>
      read('currentBranch', async () => (await plugin.currentBranch({ dir })).branch),
    verifyRef: (ref) => read('verifyRef', async () => (await plugin.revParse({ dir, ref })).sha),
    mergeBase: (a, b) => read('mergeBase', async () => (await plugin.mergeBase({ dir, a, b })).sha),
    logPatch: (range) =>
      read('logPatch', async () => (await plugin.logPatch({ dir, range })).patch),
  };
}

export function pushPlanSourceFromNativePlugin(
  plugin: NativeGitPlugin,
  dir: string,
  getToken?: () => string | undefined,
): PushPlanSource {
  const source = pushedDiffSourceFromNativePlugin(plugin, dir);
  return {
    ...source,
    lsRemoteHead: (remote, branch) =>
      readRemoteHead(async () => plugin.lsRemoteHead({ dir, remote, branch, token: getToken?.() })),
  };
}
