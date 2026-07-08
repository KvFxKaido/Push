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
 * Scope: the **`GitBackend`** contract plus the gated `PushGit` facade. Native
 * push gates now read the about-to-be-pushed patch series through typed JGit
 * primitives, so commit/push call sites can resolve the active surface here
 * instead of hardcoding the sandbox factory.
 *
 * Native arm: `resolveActiveGitBinding` only returns a `native` binding once an
 * on-device working copy is registered and ready. Until then, native sessions
 * fall through to the sandbox binding instead of inventing a half-ready clone.
 */

import type { GitBackend } from '@push/lib/git/backend';
import type { PushGit } from '@push/lib/git/push-git';
import { createSandboxGitBackend, createSandboxPushGit } from './git-backend';
import { createNativeGitBackend, createNativePushGit } from './native-git';
import type { GitHubTokenProvider } from './native-git-backend';
import { getActiveGitHubToken } from './github-auth';
import { isNativePlatform } from './platform';
import { workingCopyDir } from './native-working-copy';

/** Tagged identity of the active session's git working copy. */
export type GitSessionBinding =
  | { kind: 'sandbox'; sandboxId: string }
  | { kind: 'native'; dir: string };

/**
 * The session shape a binding is resolved from.
 *
 * `sandboxId` is the cloud-sandbox identity (and the cloud HTTP resource id used
 * across `sandbox-client.ts`); it is meaningless on native, where there is no
 * container. The on-device working copy is instead keyed by its **durable
 * scope** (`repoFullName` + `branch`) — the same CLI-first key scheme the native
 * checkpoint store already uses — so the clone survives a controller remount and
 * can be found again by scope rather than by an ephemeral id. Both are optional
 * so existing web call sites keep compiling; a native ref that omits the scope
 * cannot resolve a clone and deliberately falls through to sandbox (logged, so
 * a call site that forgot to thread the scope is not silent).
 */
export interface GitSessionRef {
  sandboxId: string;
  /** Repo `owner/name`; the first half of the native working-copy registry key. */
  repoFullName?: string;
  /** Active branch; the second half of the native working-copy registry key. */
  branch?: string;
}

/**
 * Adapts the web token helper (`() => string`, '' when none) to the native
 * provider contract (`() => string | undefined`), so a private-repo token flows
 * into the native clone/fetch/push transiently. Public/no-auth sessions get
 * `undefined` and the native engine runs unauthenticated.
 */
export const defaultNativeTokenProvider: GitHubTokenProvider = () =>
  getActiveGitHubToken() || undefined;

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
 * The session's on-device clone dir, or `undefined` when none is registered
 * (yet, still cloning, or the clone failed — the registry returns a dir only for
 * a `ready` clone). Reads the process-lifetime working-copy registry; the caller
 * ({@link resolveActiveGitBinding}) has already confirmed the scope is present.
 */
function resolveNativeWorkingCopyDir(session: GitSessionRef): string | undefined {
  if (!session.repoFullName || !session.branch) return undefined;
  return workingCopyDir({ repoFullName: session.repoFullName, branch: session.branch });
}

/**
 * Pick the git binding for the running platform. Native shell with a registered
 * working copy → `native`; otherwise (plain web, or native before its clone
 * exists) → `sandbox`.
 *
 * A native ref with no durable scope (`repoFullName`/`branch`) can't key the
 * working-copy registry, so it falls through to sandbox — but that's the "a call
 * site forgot to thread the scope" defect, not a normal transient, so it's
 * logged distinctly from the expected clone-not-ready-yet fall-through.
 */
export function resolveActiveGitBinding(
  session: GitSessionRef,
  deps: ResolveBindingDeps = {},
): GitSessionBinding {
  const isNative = deps.isNative ?? isNativePlatform;
  if (isNative()) {
    if (!session.repoFullName || !session.branch) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'native_git_binding_unscoped',
          sandboxId: session.sandboxId,
          hasRepo: Boolean(session.repoFullName),
          hasBranch: Boolean(session.branch),
        }),
      );
    } else {
      const lookup = deps.nativeWorkingCopyDir ?? resolveNativeWorkingCopyDir;
      const dir = lookup(session);
      if (dir) return { kind: 'native', dir };
      // Native shell, scope present, but no local clone yet — expected transient
      // while the clone-on-session lifecycle runs; falls through to sandbox.
    }
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

type ActivePushGitOptions = NonNullable<Parameters<typeof createSandboxPushGit>[1]>;

export function getActivePushGit(
  session: GitSessionRef,
  opts?: ActivePushGitOptions,
  deps: ResolveGitBackendDeps & ResolveBindingDeps = {},
): PushGit {
  const binding = resolveActiveGitBinding(session, deps);
  if (binding.kind === 'sandbox') return createSandboxPushGit(binding.sandboxId, opts);

  const tokenProvider = opts?.getGitHubToken
    ? () => opts.getGitHubToken?.() || undefined
    : (deps.getNativeToken ?? defaultNativeTokenProvider);
  return createNativePushGit({
    dir: binding.dir,
    getToken: tokenProvider,
    preCommit: opts?.preCommit,
    prePush: opts?.prePush,
    secretScan: opts?.secretScan,
    protectMain: opts?.protectMain,
    defaultBranch: opts?.defaultBranch,
    auditAtPush: opts?.auditAtPush,
  });
}
