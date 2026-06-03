/**
 * Centralised GitHub authentication helpers.
 *
 * Every module that needs the active GitHub token or standard auth headers
 * should import from here instead of duplicating storage-key constants.
 */

import { safeStorageGet } from './safe-storage';

export const OAUTH_STORAGE_KEY = 'github_access_token';
export const APP_TOKEN_STORAGE_KEY = 'github_app_token';
export const APP_TOKEN_EXPIRY_KEY = 'github_app_token_expiry';

/**
 * Read `VITE_GITHUB_TOKEN` lazily.
 *
 * `import.meta.env` is injected by Vite at client build time; the Worker
 * runtime doesn't have it. Evaluating `import.meta.env.VITE_GITHUB_TOKEN` at
 * module load crashed deploy validation with
 * `TypeError: Cannot read properties of undefined (reading 'VITE_GITHUB_TOKEN')`
 * whenever something in the Worker's dependency graph transitively imported
 * this module. Moving the access into a function keeps module load side-effect
 * free on any runtime; the cast widens `import.meta` so the optional chain
 * doesn't trip TS's always-defined check on Vite's `ImportMetaEnv` typing.
 */
function getEnvGitHubToken(): string {
  const metaEnv = (import.meta as ImportMeta & { env?: { VITE_GITHUB_TOKEN?: string } }).env;
  return metaEnv?.VITE_GITHUB_TOKEN ?? '';
}

/** Resolve the active GitHub token (app-token > OAuth > env). */
export function getActiveGitHubToken(): string {
  return (
    safeStorageGet(APP_TOKEN_STORAGE_KEY) ||
    safeStorageGet(OAUTH_STORAGE_KEY) ||
    getEnvGitHubToken()
  );
}

/**
 * Build standard GitHub REST API headers for an explicit token.
 *
 * Server-side callers (e.g. the PrReviewJob Durable Object, which can't read the
 * browser's localStorage token) pass an installation token here. The browser
 * default `getGitHubAuthHeaders` delegates to this with the active token.
 *
 * `User-Agent` and `X-GitHub-Api-Version` are required/expected by the GitHub
 * API from a Worker `fetch` (a UA-less request is rejected). Browsers treat
 * `User-Agent` as a forbidden header and silently drop it, so including it here
 * is harmless on the web path and correct on the server path.
 */
export function getGitHubAuthHeadersForToken(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Push-App/1.0.0',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}

/** Build standard GitHub REST API headers using the active (browser) token. */
export function getGitHubAuthHeaders(): Record<string, string> {
  return getGitHubAuthHeadersForToken(getActiveGitHubToken());
}

// --- Token authority classification ---
//
// Push resolves a single "active" GitHub token but the credentials behind it
// have very different blast radii: a GitHub App installation token is
// repo-scoped and expires (~1h, auto-refreshed), while an OAuth token or a
// pasted PAT acts as the user's whole account and never expires on its own.
// Collapsing all of them into one opaque "connected" blob is the design bug
// this vocabulary exists to fix — every surface that shows or gates a token
// should speak in `GitHubTokenKind`, not in "is it connected".
//
// Origin (which storage key produced the token) is the source of truth for
// app-vs-user, because OAuth and pasted PATs share `github_access_token` and
// are indistinguishable by key alone. The string prefix only *refines* the
// user-scoped bucket into a human label (`oauth` vs `pat`); it never decides
// authority, so a non-cooperating token shape fails safe to `unknown`.

export type GitHubTokenKind = 'app' | 'oauth' | 'pat' | 'env' | 'unknown' | 'none';

/**
 * Classify a token by its string shape alone (no storage context).
 * GitHub prefixes: `ghs_` server/installation, `gho_`/`ghu_` OAuth user tokens,
 * `ghp_`/`github_pat_` personal access tokens. Anything else is `unknown` —
 * which callers must treat as user-scoped (fail safe), not as trusted.
 */
export function classifyTokenString(token: string): GitHubTokenKind {
  if (!token) return 'none';
  if (token.startsWith('ghs_')) return 'app';
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return 'oauth';
  if (token.startsWith('ghp_') || token.startsWith('github_pat_')) return 'pat';
  return 'unknown';
}

export interface ActiveGitHubTokenInfo {
  token: string;
  kind: GitHubTokenKind;
}

/**
 * Resolve the active token AND its authority kind in one pass, mirroring
 * `getActiveGitHubToken`'s precedence (app > OAuth > env). Origin decides the
 * kind; the prefix only splits the user-scoped key into `oauth`/`pat` for
 * display. A token in the OAuth key whose shape we don't recognize stays
 * `oauth` (it came through the user flow) rather than `unknown`.
 */
export function getActiveGitHubTokenInfo(): ActiveGitHubTokenInfo {
  const appToken = safeStorageGet(APP_TOKEN_STORAGE_KEY);
  if (appToken) return { token: appToken, kind: 'app' };

  const oauthToken = safeStorageGet(OAUTH_STORAGE_KEY);
  if (oauthToken) {
    const shape = classifyTokenString(oauthToken);
    // Origin is the user flow: only a recognized PAT shape demotes to 'pat';
    // everything else (gho_/ghu_/unrecognized) reads as 'oauth'.
    return { token: oauthToken, kind: shape === 'pat' ? 'pat' : 'oauth' };
  }

  const envToken = getEnvGitHubToken();
  if (envToken) return { token: envToken, kind: 'env' };

  return { token: '', kind: 'none' };
}

/** True for the only regime that is repo-scoped AND self-expiring. */
export function isInstallationToken(kind: GitHubTokenKind): boolean {
  return kind === 'app';
}

/**
 * True when the token acts with durable, user-scoped authority — the regime
 * that's risky to bake into a sandbox. `unknown` is included on purpose
 * (fail safe). `none` and `app` are excluded.
 */
export function isDurableUserToken(kind: GitHubTokenKind): boolean {
  return kind === 'oauth' || kind === 'pat' || kind === 'env' || kind === 'unknown';
}

export interface GitHubTokenDescription {
  /** Short human label for the credential type. */
  label: string;
  /** One line on what the token can do (blast radius). */
  authority: string;
  /** Whether it expires on its own. */
  selfExpiring: boolean;
}

/** Single source of truth for user-facing copy about a token kind. */
export function describeGitHubTokenKind(kind: GitHubTokenKind): GitHubTokenDescription {
  switch (kind) {
    case 'app':
      return {
        label: 'GitHub App installation',
        authority: 'Scoped to installed repositories · refreshes automatically',
        selfExpiring: true,
      };
    case 'oauth':
      return {
        label: 'OAuth user token',
        authority: 'Acts as your full GitHub account (repo scope) · no automatic expiry',
        selfExpiring: false,
      };
    case 'pat':
      return {
        label: 'Personal access token',
        authority: 'Acts as your full GitHub account · no automatic expiry',
        selfExpiring: false,
      };
    case 'env':
      return {
        label: 'Build-time token',
        authority: 'Provided via VITE_GITHUB_TOKEN · scope opaque · no automatic expiry',
        selfExpiring: false,
      };
    case 'unknown':
      return {
        label: 'Unrecognized token',
        authority: 'Treated as full-account access (shape not recognized)',
        selfExpiring: false,
      };
    case 'none':
      return {
        label: 'Not connected',
        authority: 'No GitHub access',
        selfExpiring: false,
      };
  }
}

/** Read the App installation token's expiry (ISO string) if present. */
export function getAppTokenExpiry(): string | null {
  return safeStorageGet(APP_TOKEN_EXPIRY_KEY) || null;
}
