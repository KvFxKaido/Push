import type { PushedDiffSource } from '@push/lib/git/pushed-diff-source';
import type { NativeGitPlugin } from './definitions';

async function read<T>(task: () => Promise<T | null | undefined>): Promise<T | null> {
  try {
    return (await task()) ?? null;
  } catch {
    return null;
  }
}

export function pushedDiffSourceFromNativePlugin(
  plugin: NativeGitPlugin,
  dir: string,
): PushedDiffSource {
  return {
    currentBranch: () => read(async () => (await plugin.currentBranch({ dir })).branch),
    verifyRef: (ref) => read(async () => (await plugin.revParse({ dir, ref })).sha),
    mergeBase: (a, b) => read(async () => (await plugin.mergeBase({ dir, a, b })).sha),
    logPatch: (range) => read(async () => (await plugin.logPatch({ dir, range })).patch),
  };
}
