import { registerPlugin } from '@capacitor/core';
import type { NativeGitPlugin } from './definitions';

/**
 * The `NativeGit` plugin proxy. On Android this binds to the Kotlin
 * `@CapacitorPlugin(name = "NativeGit")`; on web it loads the rejecting stub
 * (local git is native-only).
 */
const NativeGit = registerPlugin<NativeGitPlugin>('NativeGit', {
  web: () => import('./web').then((m) => new m.NativeGitWeb()),
});

export * from './definitions';
export { NativeGit };
