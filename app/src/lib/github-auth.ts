/**
 * Centralised GitHub authentication helpers.
 *
 * Every module that needs the active GitHub token or standard auth headers
 * should import from here instead of duplicating storage-key constants.
 */

import { safeStorageGet } from './safe-storage';

export const OAUTH_STORAGE_KEY = 'github_access_token';
export const APP_TOKEN_STORAGE_KEY = 'github_app_token';

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
