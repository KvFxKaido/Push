/**
 * Cloud-sandbox repo-authorization gate.
 *
 * When a cloud sandbox clones a private repo, the active GitHub token is sent to
 * the sandbox backend for clone auth. The backend strips it from the repo remote
 * immediately after clone; sanctioned PushGit network operations inject auth
 * transiently for the single git process that needs it. The blessed path is a
 * GitHub App *installation* token — repo-scoped, ~1h, auto-refreshing. The job
 * of this gate is therefore repo-auth *clarity*:
 *
 *   - App installation token (the default) → check that the installation
 *     actually covers the active repo. If it does, clone. If it doesn't, stop
 *     early with an actionable "install/update the App on this repo" message
 *     instead of a cryptic git clone failure deep in the sandbox.
 *   - A durable user-scoped token (legacy OAuth/PAT) → still honored, but only
 *     behind a one-time acknowledgment, because it's the user's whole account
 *     sitting readable inside the container. This is the de-emphasized legacy
 *     path; there is no UI to add a new one.
 *
 * The decision is a pure function so it can be unit tested without storage or
 * network; coverage is resolved by the caller (server probe) and passed in.
 */

import { isDurableUserToken, isInstallationToken, type GitHubTokenKind } from './github-auth';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

export const SANDBOX_USER_TOKEN_ACK_KEY = 'github_sandbox_user_token_ack';

/** Whether the GitHub App installation covers the active repo. `unknown` when
 * the coverage probe was unavailable (network/transient) — treated as fail-open
 * so a flaky probe never blocks a sandbox; the clone itself surfaces any real
 * access failure. Only meaningful for the installation-token path. */
export type RepoCoverage = 'covered' | 'not_covered' | 'unknown';

/**
 * Shown when a *legacy* durable user token is blocked pending acknowledgment.
 * Leads with the legacy framing and steers to the App — normal App-installation
 * users never see this (their token is an installation token).
 */
export const USER_TOKEN_GATE_MESSAGE =
  'This is a legacy full-account GitHub token (OAuth or PAT). It would be ' +
  'sent to the cloud sandbox for clone/auth operations. Acknowledge this in ' +
  'Settings → GitHub connection to use it, or connect the GitHub App for ' +
  'scoped, auto-expiring access (recommended).';

/** Actionable message when the App installation doesn't cover the active repo. */
export function formatRepoNotCoveredMessage(repo: string, installUrl?: string): string {
  const where = installUrl ? ` at ${installUrl}` : '';
  return (
    `The Push GitHub App doesn't have access to ${repo}. Install or update ` +
    `its repository access${where}, then retry.`
  );
}

export type RepoAuthDecision =
  | { allow: true }
  | { allow: false; reason: 'needs_ack' }
  | { allow: false; reason: 'app_repo_not_covered' };

/**
 * Decide whether a sandbox may be created for the given token authority + repo
 * coverage.
 *
 * - No repo (`hasRepo: false`) → ephemeral sandbox, no token injected → allow.
 * - Installation token → allow unless coverage is definitively `not_covered`
 *   (then `app_repo_not_covered`). `covered`/`unknown` both allow (fail-open on
 *   an unavailable probe).
 * - No token → nothing injected (public clone / ephemeral) → allow.
 * - Durable user-scoped token → allow only if explicitly acknowledged.
 */
export function evaluateRepoAuth(input: {
  kind: GitHubTokenKind;
  hasRepo: boolean;
  coverage: RepoCoverage;
  acknowledged: boolean;
}): RepoAuthDecision {
  if (!input.hasRepo) return { allow: true };

  if (isInstallationToken(input.kind)) {
    return input.coverage === 'not_covered'
      ? { allow: false, reason: 'app_repo_not_covered' }
      : { allow: true };
  }

  if (!isDurableUserToken(input.kind)) return { allow: true };

  return input.acknowledged ? { allow: true } : { allow: false, reason: 'needs_ack' };
}

/** Whether the user has acknowledged injecting a legacy user-scoped token into a cloud sandbox. */
export function hasAcknowledgedUserTokenInjection(): boolean {
  return safeStorageGet(SANDBOX_USER_TOKEN_ACK_KEY) === '1';
}

/** Persist (or clear) the legacy user-scoped-token sandbox acknowledgment. */
export function setAcknowledgedUserTokenInjection(acknowledged: boolean): void {
  if (acknowledged) {
    safeStorageSet(SANDBOX_USER_TOKEN_ACK_KEY, '1');
  } else {
    safeStorageRemove(SANDBOX_USER_TOKEN_ACK_KEY);
  }
}
