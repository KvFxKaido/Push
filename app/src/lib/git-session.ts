/**
 * Git backend selection seam.
 *
 * Every git read/write on web today is keyed on a `sandboxId` and built with
 * `createSandboxGitBackend` directly. The mobile shell has no sandbox — it owns
 * an on-device working copy and drives JGit through `NativeGitBackend` (keyed
 * by an absolute `dir`). These are two different *identity models* for the same
 * `GitBackend` contract.
 *
 * This module is the one place that maps a session to its backend, so call
 * sites stop hardcoding the sandbox factory. A `GitSessionBinding` is the
 * tagged identity (`sandbox` → id, `native` → dir); `resolveGitBackend`
 * dispatches it to the matching factory; `resolveActiveGitBinding` picks the
 * binding for the running platform.
 *
 * Scope (increment 1): the **`GitBackend`** contract only — typed reads plus
 * the raw branch/commit/push writes, which both backends implement identically.
 * The gated `PushGit` facade (`createSandboxPushGit`) is deliberately NOT routed
 * here yet: its secret-scan / Protect-Main / Auditor gates read an
 * about-to-be-pushed *diff* that the native plugin doesn't expose, so unifying
 * gate composition is its own later increment.
 *
 * Dormant native arm: `resolveActiveGitBinding` only returns a `native` binding
 * once an on-device working copy is registered. That registry (clone-on-session
 * lifecycle) lands in a later increment, so on native today this falls through
 * to the sandbox binding. The `native` dispatch path itself is wired and
 * unit-tested via an explicit binding.
 */

import type { GitBackend } from '@push/lib/git/backend';
import { createSandboxGitBackend } from './git-backend';
import { createNativeGitBackend } from './native-git';
import type { GitHubTokenProvider } from './native-git-backend';
import { getActiveGitHubToken } from './github-auth';
import { isNativePlatform } from './platform';

/** Tagged identity of the active session's git working copy. */
export type GitSessionBinding =
  | { kind: 'sandbox'; sandboxId: string }
  | { kind: 'native'; dir: string };

/** The minimal session shape the binding is resolved from. */
export interface GitSessionRef {
  sandboxId: string;
}

/**
 * Adapts the web token helper (`() => string`, '' when none) to the native
 * provider contract (`() => string | undefined`), so a private-repo token flows
 * into the native clone/fetch/push transiently. Public/no-auth sessions get
 * `undefined` and the native engine runs unauthenticated.
 */
const defaultNativeTokenProvider: GitHubTokenProvider = () => getActiveGitHubToken() || undefined;

export interface ResolveGitBackendDeps {
  /** Token provider injected into the native backend (defaults to the active GitHub token). */
  getNativeToken?: GitHubTokenProvider;
}

/**
 * Dispatch a binding to its `GitBackend` implementation. Pure — no platform or
 * global lookups — so both arms are unit-testable with an explicit binding.
 */
export function resolveGitBackend(
  binding: GitSessionBinding,
  deps: ResolveGitBackendDeps = {},
): GitBackend {
  switch (binding.kind) {
    case 'sandbox':
      return createSandboxGitBackend(binding.sandboxId);
    case 'native':
      return createNativeGitBackend({
        dir: binding.dir,
        getToken: deps.getNativeToken ?? defaultNativeTokenProvider,
      });
  }
}

export interface ResolveBindingDeps {
  /** Platform probe (defaults to the real Capacitor check); injectable for tests. */
  isNative?: () => boolean;
  /**
   * Lookup for the session's registered on-device working-copy dir. Returns
   * `undefined` until the clone-on-session lifecycle (later increment) registers
   * one — that's what keeps the native arm dormant today.
   */
  nativeWorkingCopyDir?: (session: GitSessionRef) => string | undefined;
}

/**
 * The session's on-device clone, or `undefined` when none is registered.
 * Placeholder until the clone lifecycle increment supplies a real registry;
 * isolated here so that increment is a one-function change.
 */
function resolveNativeWorkingCopyDir(): string | undefined {
  return undefined;
}

/**
 * Pick the git binding for the running platform. Native shell with a registered
 * working copy → `native`; otherwise (plain web, or native before its clone
 * exists) → `sandbox`.
 */
export function resolveActiveGitBinding(
  session: GitSessionRef,
  deps: ResolveBindingDeps = {},
): GitSessionBinding {
  const isNative = deps.isNative ?? isNativePlatform;
  if (isNative()) {
    const lookup = deps.nativeWorkingCopyDir ?? resolveNativeWorkingCopyDir;
    const dir = lookup(session);
    if (dir) return { kind: 'native', dir };
    // Native shell but no local working copy yet — fall through to sandbox.
  }
  return { kind: 'sandbox', sandboxId: session.sandboxId };
}

/**
 * Convenience entry point used by call sites: resolve the active binding for
 * this session and return its `GitBackend`. Replaces direct
 * `createSandboxGitBackend(sandboxId)` calls so the backend choice is made in
 * one place.
 */
export function getActiveGitBackend(
  session: GitSessionRef,
  deps: ResolveGitBackendDeps & ResolveBindingDeps = {},
): GitBackend {
  return resolveGitBackend(resolveActiveGitBinding(session, deps), deps);
}
