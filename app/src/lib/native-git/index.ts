/**
 * Native (Android) git adapter — the factory seam, mirroring the web
 * (`createSandboxGitBackend` / `createSandboxPushGit`) and CLI
 * (`createLocalGitBackend` / `createLocalPushGit`) adapters. Selected on the
 * native platform; injects the real `NativeGit` plugin into the testable
 * `NativeGitBackend`.
 */

import { PushGit, type PreCommitGate, type PrePushGate } from '@push/lib/git/push-git';
import {
  NativeGitBackend,
  type GitHubTokenProvider,
  type NativeGitBackendOptions,
} from '../native-git-backend';
import { NativeGit } from './plugin';

export type { NativeGitPlugin } from './definitions';

/** Build a GitBackend over the on-device clone at `opts.dir`. */
export function createNativeGitBackend(opts: NativeGitBackendOptions): NativeGitBackend {
  return new NativeGitBackend(NativeGit, opts);
}

/**
 * Build a PushGit facade over the on-device clone. `preCommit` / `prePush` are
 * the same gate seams the web/CLI use — the Auditor and secret-scan gates plug
 * in here unchanged.
 */
export function createNativePushGit(opts: {
  dir: string;
  getToken?: GitHubTokenProvider;
  preCommit?: PreCommitGate;
  prePush?: PrePushGate;
}): PushGit {
  return new PushGit({
    backend: createNativeGitBackend({ dir: opts.dir, getToken: opts.getToken }),
    preCommit: opts.preCommit,
    prePush: opts.prePush,
  });
}
