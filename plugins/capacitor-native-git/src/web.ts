import { WebPlugin } from '@capacitor/core';
import type { NativeGitPlugin } from './definitions';

/**
 * Web stub. Local git runs only inside the native shell; the web / sandbox
 * surface uses the sandbox-backed GitBackend instead. Every method rejects so a
 * mistaken web-side use fails loudly rather than silently no-ops.
 */
export class NativeGitWeb extends WebPlugin implements NativeGitPlugin {
  private notAvailable(): never {
    throw this.unimplemented('NativeGit is only available in the native (Android) shell');
  }

  clone(): Promise<never> {
    return this.notAvailable();
  }
  currentBranch(): Promise<never> {
    return this.notAvailable();
  }
  upstreamRef(): Promise<never> {
    return this.notAvailable();
  }
  remoteUrl(): Promise<never> {
    return this.notAvailable();
  }
  headSha(): Promise<never> {
    return this.notAvailable();
  }
  status(): Promise<never> {
    return this.notAvailable();
  }
  diff(): Promise<never> {
    return this.notAvailable();
  }
  createBranch(): Promise<never> {
    return this.notAvailable();
  }
  switchBranch(): Promise<never> {
    return this.notAvailable();
  }
  commit(): Promise<never> {
    return this.notAvailable();
  }
  push(): Promise<never> {
    return this.notAvailable();
  }
  fetch(): Promise<never> {
    return this.notAvailable();
  }
  readFile(): Promise<never> {
    return this.notAvailable();
  }
  writeFile(): Promise<never> {
    return this.notAvailable();
  }
  listDir(): Promise<never> {
    return this.notAvailable();
  }
  commitWorkingTree(): Promise<never> {
    return this.notAvailable();
  }
  archiveCommit(): Promise<never> {
    return this.notAvailable();
  }
  listCheckpoints(): Promise<never> {
    return this.notAvailable();
  }
  pruneCheckpoints(): Promise<never> {
    return this.notAvailable();
  }
  dropCheckpoint(): Promise<never> {
    return this.notAvailable();
  }
  clearCheckpoints(): Promise<never> {
    return this.notAvailable();
  }
  listManifest(): Promise<never> {
    return this.notAvailable();
  }
  commitDelta(): Promise<never> {
    return this.notAvailable();
  }
}
