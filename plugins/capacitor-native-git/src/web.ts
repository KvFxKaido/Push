import { WebPlugin } from '@capacitor/core';
import type { NativeGitPlugin } from './definitions';

/**
 * Web stub. Local git runs only inside the native shell; the web / sandbox
 * surface uses the sandbox-backed GitBackend instead. Every method rejects so a
 * mistaken web-side use fails loudly rather than silently no-ops.
 */
export class NativeGitWeb extends WebPlugin implements NativeGitPlugin {
  private unavailable(): never {
    throw this.unimplemented('NativeGit is only available in the native (Android) shell');
  }

  clone(): Promise<never> {
    return this.unavailable();
  }
  currentBranch(): Promise<never> {
    return this.unavailable();
  }
  upstreamRef(): Promise<never> {
    return this.unavailable();
  }
  remoteUrl(): Promise<never> {
    return this.unavailable();
  }
  headSha(): Promise<never> {
    return this.unavailable();
  }
  status(): Promise<never> {
    return this.unavailable();
  }
  createBranch(): Promise<never> {
    return this.unavailable();
  }
  switchBranch(): Promise<never> {
    return this.unavailable();
  }
  commit(): Promise<never> {
    return this.unavailable();
  }
  push(): Promise<never> {
    return this.unavailable();
  }
  fetch(): Promise<never> {
    return this.unavailable();
  }
}
