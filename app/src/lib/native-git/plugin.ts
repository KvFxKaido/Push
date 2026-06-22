/**
 * Registers the `NativeGit` Capacitor plugin (the JGit-backed Android engine).
 *
 * Kept in its own module — separate from `NativeGitBackend` — so the backend
 * stays free of `@capacitor/core` and unit-testable with a mock plugin. Only
 * the native client path imports this. There is intentionally no web
 * implementation: local git runs only inside the native shell; the web /
 * sandbox surface uses the sandbox-backed `GitBackend` instead. The web stub
 * rejects every call so a mistaken web-side use fails loudly rather than
 * silently no-ops.
 */

import { registerPlugin } from '@capacitor/core';
import type { NativeGitPlugin } from './definitions';

export const NativeGit = registerPlugin<NativeGitPlugin>('NativeGit', {
  web: () =>
    new Proxy({} as NativeGitPlugin, {
      get: () => (): Promise<never> =>
        Promise.reject(new Error('NativeGit is only available in the native (Android) shell')),
    }),
});
