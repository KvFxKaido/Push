/**
 * Native (Android) git adapter — the factory seam, mirroring the web
 * (`createSandboxGitBackend` / `createSandboxPushGit`) and CLI
 * (`createLocalGitBackend` / `createLocalPushGit`) adapters. Selected on the
 * native platform; injects the real `NativeGit` plugin into the testable
 * `NativeGitBackend`.
 */

import { PushGit, type PreCommitGate, type PrePushGate } from '@push/lib/git/push-git';
import { computePushedDiffFromSource, type PushedDiffOptions } from '@push/lib/git/pushed-diff';
import { computePushPlanFromSource, type PushPlan } from '@push/lib/git/push-plan';
import type { AuditorPushVerdict } from '@push/lib/git/auditor-push-gate';
import {
  NativeGitBackend,
  type GitHubTokenProvider,
  type NativeGitBackendOptions,
} from '../native-git-backend';
import { buildPushPrePushGate } from '../push-git-gates';
import { NativeGit } from './plugin';
import {
  pushedDiffSourceFromNativePlugin,
  pushPlanSourceFromNativePlugin,
} from './pushed-diff-source';

export type { NativeGitPlugin } from './definitions';

/** Build a GitBackend over the on-device clone at `opts.dir`. */
export function createNativeGitBackend(opts: NativeGitBackendOptions): NativeGitBackend {
  return new NativeGitBackend(NativeGit, opts);
}

export interface NativePushGitOptions {
  dir: string;
  getToken?: GitHubTokenProvider;
  preCommit?: PreCommitGate;
  prePush?: PrePushGate;
  secretScan?: boolean;
  protectMain?: boolean;
  defaultBranch?: string;
  auditAtPush?: {
    audit: (diff: string) => Promise<AuditorPushVerdict>;
    enabled?: boolean;
  };
}

export function computeNativePushedDiff(
  dir: string,
  opts?: PushedDiffOptions,
): Promise<string | null> {
  return computePushedDiffFromSource(pushedDiffSourceFromNativePlugin(NativeGit, dir), opts);
}

export function computeNativePushPlan(
  dir: string,
  opts?: { ref?: string; remote?: string; getToken?: GitHubTokenProvider },
): Promise<PushPlan> {
  return computePushPlanFromSource(pushPlanSourceFromNativePlugin(NativeGit, dir, opts?.getToken), {
    ref: opts?.ref,
    remote: opts?.remote,
  });
}

export async function nativeBranchExists(dir: string, branch: string): Promise<boolean> {
  try {
    const [local, remote] = await Promise.all([
      NativeGit.revParse({ dir, ref: `refs/heads/${branch}` }),
      NativeGit.revParse({ dir, ref: `refs/remotes/origin/${branch}` }),
    ]);
    return Boolean(local.sha || remote.sha);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'native_branch_exists_failed',
        branch,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return true;
  }
}

/**
 * Build a PushGit facade over the on-device clone. `preCommit` / `prePush` are
 * the same gate seams the web/CLI use; `secretScan`, Protect Main, and
 * push-time Auditor all read the native per-commit pushed diff, not the capped
 * working-tree preview.
 */
export function createNativePushGit(opts: NativePushGitOptions): PushGit {
  const backend = createNativeGitBackend({ dir: opts.dir, getToken: opts.getToken });
  const source = pushedDiffSourceFromNativePlugin(NativeGit, opts.dir);
  const prePush = buildPushPrePushGate({
    prePush: opts.prePush,
    protectMain: opts.protectMain,
    defaultBranch: opts.defaultBranch,
    getCurrentBranch: () => backend.currentBranch(),
    secretScan: opts.secretScan,
    getPushedDiff: (pushOpts) =>
      computePushedDiffFromSource(source, { ...pushOpts, defaultBranch: opts.defaultBranch }),
    auditAtPush: opts.auditAtPush,
  });
  return new PushGit({
    backend,
    preCommit: opts.preCommit,
    prePush,
  });
}
