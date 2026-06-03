/**
 * Cloud-sandbox credential gate.
 *
 * When a cloud sandbox clones a repo, the active GitHub token is baked into the
 * clone URL and persists in the container's `.git/config` for the sandbox's
 * lifetime (see worker-cf-sandbox.ts). For a GitHub App *installation* token
 * that's tolerable — it's repo-scoped and expires in ~1h. For a user-scoped
 * token (OAuth or PAT) it's the user's whole GitHub account sitting readable
 * inside the container, indefinitely.
 *
 * This gate makes that asymmetry explicit instead of silent: injecting a
 * durable user-scoped token into a cloud sandbox requires a one-time, explicit
 * acknowledgment. Installation tokens (and the no-clone ephemeral sandbox mode)
 * pass through untouched. The decision is a pure function so it can be unit
 * tested without storage; persistence lives in the helpers below.
 */

import { isDurableUserToken, type GitHubTokenKind } from './github-auth';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

export const SANDBOX_USER_TOKEN_ACK_KEY = 'github_sandbox_user_token_ack';

/**
 * Shown when sandbox creation is blocked pending acknowledgment. Kept here so
 * the hook that surfaces it and the tests that assert on it share one string.
 */
export const USER_TOKEN_GATE_MESSAGE =
  'This GitHub token acts as your full account and would be written into the ' +
  'cloud sandbox, readable for its lifetime. Acknowledge this in Settings → ' +
  'GitHub connection to use a cloud sandbox, or connect the GitHub App for a ' +
  'scoped, auto-expiring token instead.';

export type SandboxAuthGateDecision = { allow: true } | { allow: false; reason: 'needs_ack' };

/**
 * Decide whether a sandbox may be created with the given token authority.
 *
 * - No repo (`hasRepo: false`) → ephemeral sandbox, no token injected → allow.
 * - Installation token / no token → allow (scoped + expiring, or nothing).
 * - Durable user-scoped token → allow only if explicitly acknowledged.
 */
export function evaluateSandboxAuthGate(input: {
  kind: GitHubTokenKind;
  hasRepo: boolean;
  acknowledged: boolean;
}): SandboxAuthGateDecision {
  if (!input.hasRepo) return { allow: true };
  if (!isDurableUserToken(input.kind)) return { allow: true };
  return input.acknowledged ? { allow: true } : { allow: false, reason: 'needs_ack' };
}

/** Whether the user has acknowledged injecting a user-scoped token into a cloud sandbox. */
export function hasAcknowledgedUserTokenInjection(): boolean {
  return safeStorageGet(SANDBOX_USER_TOKEN_ACK_KEY) === '1';
}

/** Persist (or clear) the user-scoped-token sandbox acknowledgment. */
export function setAcknowledgedUserTokenInjection(acknowledged: boolean): void {
  if (acknowledged) {
    safeStorageSet(SANDBOX_USER_TOKEN_ACK_KEY, '1');
  } else {
    safeStorageRemove(SANDBOX_USER_TOKEN_ACK_KEY);
  }
}
