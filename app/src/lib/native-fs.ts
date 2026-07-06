/**
 * On-device working-copy filesystem backend (native/APK only).
 *
 * The mobile shell's non-git tools (`sandbox_read_file` / `sandbox_write_file` /
 * `sandbox_list_dir`) can't reach the cloud sandbox's HTTP file API — there's no
 * sandbox. They route here instead: plain file I/O inside the session's on-device
 * clone, driven through the `NativeGit` Capacitor plugin (which owns the working
 * copy). This is the FS analog of `native-git-backend.ts`.
 *
 * Path model: tools speak the cloud `/workspace/...` convention (or a bare
 * relative path). {@link toWorktreeRelative} maps either onto a path relative to
 * the clone root, which is all the plugin's `dir`-scoped ops accept — so a tool
 * path can never escape the clone.
 *
 * Result shapes mirror the local-daemon FS helpers so the tool dispatcher formats
 * native and daemon results with identical code (only the source of the bytes
 * differs). Web has no working copy: {@link resolveNativeFs} returns `null` off
 * the native platform, and the plugin stub rejects if a call slips through.
 */

import { NativeGit } from './native-git/plugin';
import type { NativeGitPlugin } from './native-git/definitions';
import { isNativePlatform } from './platform';
import { isNativeWorkingCopyEnabled } from './feature-flags';
import { workingCopyDir, type WorkingCopyScope } from './native-working-copy';

export interface NativeFsReadResult {
  content: string;
  truncated: boolean;
  totalLines?: number;
  error?: string;
  code?: string;
}
export interface NativeFsWriteResult {
  ok: boolean;
  bytesWritten?: number;
  error?: string;
}
export interface NativeFsDirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}
export interface NativeFsListResult {
  entries: NativeFsDirEntry[];
  truncated: boolean;
  error?: string;
}

/**
 * Map a tool path onto a path relative to the clone root. Strips the cloud
 * `/workspace` root convention and any leading slash, so both `/workspace/src/a`
 * and `src/a` resolve under the clone — and an absolute-looking path can't escape
 * it. The clone root itself (`/workspace` or `''`) maps to `''`.
 */
export function toWorktreeRelative(path: string | undefined): string {
  if (!path) return '';
  const trimmed = path.trim();
  if (trimmed === '/workspace' || trimmed === '/workspace/') return '';
  return trimmed.replace(/^\/workspace\//, '').replace(/^\/+/, '');
}

/** File I/O over one on-device clone at `dir`. Constructed by {@link resolveNativeFs}. */
export class NativeFsBackend {
  private readonly plugin: NativeGitPlugin;
  private readonly dir: string;

  constructor(plugin: NativeGitPlugin, dir: string) {
    this.plugin = plugin;
    this.dir = dir;
  }

  readFile(
    path: string,
    opts: { startLine?: number; endLine?: number } = {},
  ): Promise<NativeFsReadResult> {
    return this.plugin.readFile({
      dir: this.dir,
      path: toWorktreeRelative(path),
      startLine: opts.startLine,
      endLine: opts.endLine,
    });
  }

  writeFile(path: string, content: string): Promise<NativeFsWriteResult> {
    return this.plugin.writeFile({ dir: this.dir, path: toWorktreeRelative(path), content });
  }

  listDir(path?: string): Promise<NativeFsListResult> {
    return this.plugin.listDir({
      dir: this.dir,
      path: path ? toWorktreeRelative(path) : undefined,
    });
  }
}

/**
 * Build a `nativeFsScope` for `SandboxExecutionOptions` from the loosely-typed
 * refs the chat layer holds (`repoRef`, `branchInfoRef`). Returns `undefined`
 * unless both halves are present — an incomplete scope can't key the registry,
 * so it correctly resolves to no native FS (cloud/daemon path). Keeps the ~4
 * option-build sites consistent instead of each re-deriving the scope.
 */
export function nativeFsScopeFrom(
  repoFullName: string | null | undefined,
  branch: string | null | undefined,
): WorkingCopyScope | undefined {
  return repoFullName && branch ? { repoFullName, branch } : undefined;
}

/** Injectable seams for {@link resolveNativeFs} (all default to the real ones). */
export interface ResolveNativeFsDeps {
  isNative?: () => boolean;
  isEnabled?: () => boolean;
  workingCopyDir?: (scope: WorkingCopyScope) => string | undefined;
  plugin?: NativeGitPlugin;
}

/**
 * The native FS backend for a session, or `null` when it doesn't apply — off the
 * native platform, flag off, no scope, or no ready clone yet. A `null` return is
 * the dispatcher's signal to fall through to the cloud/daemon path, so file ops
 * degrade gracefully while a clone is still in flight.
 */
export function resolveNativeFs(
  scope: WorkingCopyScope | undefined,
  deps: ResolveNativeFsDeps = {},
): NativeFsBackend | null {
  const isNative = deps.isNative ?? isNativePlatform;
  const isEnabled = deps.isEnabled ?? isNativeWorkingCopyEnabled;
  if (!scope || !isNative() || !isEnabled()) return null;
  const dir = (deps.workingCopyDir ?? workingCopyDir)(scope);
  if (!dir) return null;
  return new NativeFsBackend(deps.plugin ?? NativeGit, dir);
}
