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
 * Dirs skipped by name at any depth, independent of .gitignore. Deliberately
 * tiny — only universally-generated trees; everything else defers to the
 * repo's own .gitignore so real source dirs can't be silently excluded.
 */
const NATIVE_SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules']);

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal top-level .gitignore matcher so the native search walk stays
 * consistent with the rg/grep transports (which honor ignore rules) and
 * doesn't pump generated trees through the Capacitor bridge file-by-file.
 * Supported subset: comments/blank lines, trailing-slash dir patterns, `*`
 * within a segment, root-anchored patterns containing `/`, and negations
 * (`!pattern`) — a matching negation always wins over a matching exclusion,
 * ignoring git's last-match-wins ordering and re-inclusion-inside-excluded-dir
 * rules. `**` and unparseable patterns don't exclude. Every simplification
 * errs toward searching too much rather than silently missing matches.
 */
export function buildGitignoreMatcher(content: string): (relPath: string) => boolean {
  const compile = (pattern: string, nameGlobs: RegExp[], rootedGlobs: RegExp[]) => {
    const trimmed = pattern.replace(/\/+$/, '');
    if (!trimmed || trimmed.includes('**')) return;
    const anchored = trimmed.includes('/');
    const cleaned = trimmed.replace(/^\//, '');
    const source = `^${cleaned.split('*').map(escapeRegExpLiteral).join('[^/]*')}$`;
    try {
      (anchored ? rootedGlobs : nameGlobs).push(new RegExp(source));
    } catch {
      // Unparseable pattern → doesn't exclude.
    }
  };
  const nameGlobs: RegExp[] = [];
  const rootedGlobs: RegExp[] = [];
  const negatedNameGlobs: RegExp[] = [];
  const negatedRootedGlobs: RegExp[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      compile(line.slice(1), negatedNameGlobs, negatedRootedGlobs);
    } else {
      compile(line, nameGlobs, rootedGlobs);
    }
  }
  return (relPath) => {
    const name = relPath.split('/').pop() ?? relPath;
    const excluded =
      nameGlobs.some((glob) => glob.test(name)) || rootedGlobs.some((glob) => glob.test(relPath));
    if (!excluded) return false;
    const reIncluded =
      negatedNameGlobs.some((glob) => glob.test(name)) ||
      negatedRootedGlobs.some((glob) => glob.test(relPath));
    return !reIncluded;
  };
}

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
  readonly dir: string;

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

    // Returns the read error (if any) so the root-path case can surface it;
    // per-file errors during a directory walk are skipped like rg skips
    // unreadable files. The plugin caps reads (~200KB), so a large file is
    // read in chunks — matching only the first chunk would silently miss
    // matches past the cap that rg would find. `totalLines` (full-file count,
    // reported even on capped reads) drives the pagination.
    const searchFile = async (rel: string): Promise<string | null> => {
      const displayPath = `/workspace/${rel}`;
      let lineOffset = 0;
      let knownTotalLines: number | undefined;
      for (;;) {
        const read = await this.readFile(
          rel,
          lineOffset === 0 ? {} : { startLine: lineOffset + 1 },
        );
        if (read.error) return lineOffset === 0 ? read.error : null;
        const fileLines = read.content.split('\n');
        for (let i = 0; i < fileLines.length; i += 1) {
          if (!matchesLine(fileLines[i])) continue;
          lines.push(`${displayPath}:${lineOffset + i + 1}:${fileLines[i]}`);
          if (lines.length >= NATIVE_SEARCH_MAX_RESULTS) {
            truncated = true;
            return null;
          }
        }
        knownTotalLines ??= read.totalLines;
        lineOffset += fileLines.length;
        // Done when the transport says so, when progress stalls (safety), or
        // when the full extent is unknown (older transports: single pass).
        if (!read.truncated || fileLines.length === 0 || knownTotalLines === undefined) return null;
        if (lineOffset >= knownTotalLines) return null;
      }
    };

    // Honor the repo's top-level .gitignore so the walk matches the rg/grep
    // transports and skips generated trees instead of pumping them through
    // the bridge file-by-file. Best-effort: no .gitignore → nothing ignored.
    let isIgnored: (relPath: string) => boolean = () => false;

    const walkEntries = async (rel: string, entries: NativeFsDirEntry[]): Promise<void> => {
      for (const entry of entries) {
        if (lines.length >= NATIVE_SEARCH_MAX_RESULTS) {
          truncated = true;
          return;
        }
        if (NATIVE_SEARCH_SKIP_DIRS.has(entry.name)) continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (isIgnored(child)) continue;
        if (entry.type === 'directory') {
          const listing = await this.listDir(child);
          if (!listing.error) {
            // A capped listing (500 entries) means unwalked files — report
            // the search as truncated rather than silently incomplete.
            if (listing.truncated) truncated = true;
            await walkEntries(child, listing.entries);
          }
          continue;
        }
        if (entry.type !== 'file') continue;

        await searchFile(child);
      }
    };

    try {
      const rootListing = await this.listDir(root);
      if (rootListing.error) {
        // Not-a-directory fallback: search the path as a single file. If that
        // ALSO fails, the path is bad — surface an error instead of a silent
        // "No matches" (the rg transport errors on nonexistent paths too).
        const readError = await searchFile(root);
        if (readError) {
          return {
            lines: [],
            truncated: false,
            error: `Search path is not a readable directory or file: ${readError}`,
          };
        }
        return { lines, truncated };
      }
      if (rootListing.truncated) truncated = true;
      const ignoreRead = await this.readFile('.gitignore');
      if (!ignoreRead.error) isIgnored = buildGitignoreMatcher(ignoreRead.content);
      await walkEntries(root, rootListing.entries);
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
