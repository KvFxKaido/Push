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

/** Build standard GitHub REST API headers using the active token. */
export function getGitHubAuthHeaders(): Record<string, string> {
  const token = getActiveGitHubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}
