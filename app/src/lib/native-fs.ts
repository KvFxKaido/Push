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
export interface NativeFsSearchResult {
  lines: string[];
  truncated: boolean;
  error?: string;
}
export interface NativeFsDiffResult {
  diff: string;
  truncated: boolean;
  git_status?: string;
  error?: string;
}

const NATIVE_SEARCH_MAX_RESULTS = 120;

/**
 * Map a tool path onto a path relative to the clone root. Strips the cloud
 * `/workspace` root convention and any leading slash, then resolves `.`/`..`
 * segments **clamped at the root** so an absolute-looking or traversing path can
 * never escape the working copy (`/workspace/../etc/passwd` → `etc/passwd`, not
 * `../etc/passwd`). The clone root itself (`/workspace` or `''`) maps to `''`.
 *
 * This is the TS-layer half of the boundary; the native `resolveWorktreeFile`
 * still canonical-path-checks against the clone dir as defense in depth.
 */
export function toWorktreeRelative(path: string | undefined): string {
  if (!path) return '';
  const trimmed = path.trim();
  if (trimmed === '/workspace' || trimmed === '/workspace/') return '';
  const stripped = trimmed.replace(/^\/workspace\//, '').replace(/^\/+/, '');
  const out: string[] = [];
  for (const seg of stripped.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop(); // clamp: `..` above the root is a no-op, never escapes
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
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

  async search(query: string, path?: string): Promise<NativeFsSearchResult> {
    const root = toWorktreeRelative(path || '');
    const lines: string[] = [];
    let truncated = false;

    // The cloud/daemon `sandbox_search` runs the query through rg/grep as a
    // regex, and the tool is presented identically on every surface — so the
    // model sends regex syntax here too. Compile it (case-sensitive, matching
    // rg's default); fall back to literal substring only when the pattern
    // doesn't parse as a regex, which is also what a model typing plain text
    // expects.
    let matchesLine: (line: string) => boolean;
    try {
      const pattern = new RegExp(query);
      matchesLine = (line) => pattern.test(line);
    } catch {
      matchesLine = (line) => line.includes(query);
    }

    const searchFile = async (rel: string): Promise<void> => {
      const read = await this.readFile(rel);
      if (read.error) return;
      const fileLines = read.content.split('\n');
      const displayPath = `/workspace/${rel}`;
      for (let i = 0; i < fileLines.length; i += 1) {
        if (!matchesLine(fileLines[i])) continue;
        lines.push(`${displayPath}:${i + 1}:${fileLines[i]}`);
        if (lines.length >= NATIVE_SEARCH_MAX_RESULTS) {
          truncated = true;
          return;
        }
      }
    };

    const walk = async (rel: string): Promise<void> => {
      if (lines.length >= NATIVE_SEARCH_MAX_RESULTS) {
        truncated = true;
        return;
      }
      const listing = await this.listDir(rel);
      if (listing.error) {
        await searchFile(rel);
        return;
      }

      for (const entry of listing.entries) {
        if (lines.length >= NATIVE_SEARCH_MAX_RESULTS) {
          truncated = true;
          return;
        }
        if (entry.name === '.git') continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.type === 'directory') {
          await walk(child);
          continue;
        }
        if (entry.type !== 'file') continue;

        await searchFile(child);
      }
    };

    try {
      await walk(root);
      return { lines, truncated };
    } catch (err) {
      return {
        lines,
        truncated,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  diff(): Promise<NativeFsDiffResult> {
    return this.plugin.diff({ dir: this.dir });
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
