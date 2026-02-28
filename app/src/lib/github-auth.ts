/**
 * Centralised GitHub authentication helpers.
 *
 * Every module that needs the active GitHub token or standard auth headers
 * should import from here instead of duplicating storage-key constants.
 */

import { safeStorageGet } from './safe-storage';

export const OAUTH_STORAGE_KEY = 'github_access_token';
export const APP_TOKEN_STORAGE_KEY = 'github_app_token';
const ENV_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

/** Resolve the active GitHub token (app-token > OAuth > env). */
export function getActiveGitHubToken(): string {
  return safeStorageGet(APP_TOKEN_STORAGE_KEY) || safeStorageGet(OAUTH_STORAGE_KEY) || ENV_TOKEN;
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
