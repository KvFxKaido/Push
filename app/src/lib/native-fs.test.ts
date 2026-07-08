import { describe, expect, it, vi } from 'vitest';
import {
  NativeFsBackend,
  resolveNativeFs,
  toWorktreeRelative,
  type ResolveNativeFsDeps,
} from './native-fs';
import type { NativeGitPlugin } from './native-git/definitions';
import type { WorkingCopyScope } from './native-working-copy';

const scope: WorkingCopyScope = { repoFullName: 'owner/repo', branch: 'main' };

describe('toWorktreeRelative', () => {
  it('strips the cloud /workspace root convention', () => {
    expect(toWorktreeRelative('/workspace/src/a.ts')).toBe('src/a.ts');
  });
  it('maps the clone root itself to empty', () => {
    expect(toWorktreeRelative('/workspace')).toBe('');
    expect(toWorktreeRelative('/workspace/')).toBe('');
    expect(toWorktreeRelative(undefined)).toBe('');
  });
  it('keeps an already-relative path relative', () => {
    expect(toWorktreeRelative('src/a.ts')).toBe('src/a.ts');
  });
  it('cannot escape the clone: any leading slash is stripped', () => {
    expect(toWorktreeRelative('/etc/passwd')).toBe('etc/passwd');
    expect(toWorktreeRelative('///a')).toBe('a');
  });
  it('neutralizes `..` traversal, clamped at the clone root', () => {
    expect(toWorktreeRelative('/workspace/../etc/passwd')).toBe('etc/passwd');
    expect(toWorktreeRelative('../../secret')).toBe('secret');
    expect(toWorktreeRelative('src/../../../etc/passwd')).toBe('etc/passwd');
    expect(toWorktreeRelative('a/b/../c')).toBe('a/c');
    expect(toWorktreeRelative('/workspace/..')).toBe('');
  });
  it('drops redundant `.` and empty segments', () => {
    expect(toWorktreeRelative('./src/./a.ts')).toBe('src/a.ts');
    expect(toWorktreeRelative('src//a.ts')).toBe('src/a.ts');
  });
});

function fakePlugin(): NativeGitPlugin {
  return {
    readFile: vi.fn(async () => ({ content: 'hi', truncated: false, totalLines: 1 })),
    writeFile: vi.fn(async () => ({ ok: true, bytesWritten: 2 })),
    listDir: vi.fn(async () => ({
      entries: [{ name: 'a.ts', type: 'file' as const }],
      truncated: false,
    })),
    diff: vi.fn(async () => ({
      diff: 'diff --git a/a.ts b/a.ts\n',
      truncated: false,
      git_status: ' M a.ts',
    })),
  } as unknown as NativeGitPlugin;
}

describe('NativeFsBackend', () => {
  it('scopes every op to the clone dir with a worktree-relative path', async () => {
    const plugin = fakePlugin();
    const fs = new NativeFsBackend(plugin, '/data/clone');

    await fs.readFile('/workspace/src/a.ts', { startLine: 2, endLine: 5 });
    expect(plugin.readFile).toHaveBeenCalledWith({
      dir: '/data/clone',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 5,
    });

    await fs.writeFile('/workspace/b.ts', 'x');
    expect(plugin.writeFile).toHaveBeenCalledWith({
      dir: '/data/clone',
      path: 'b.ts',
      content: 'x',
    });

    await fs.listDir('/workspace/src');
    expect(plugin.listDir).toHaveBeenCalledWith({ dir: '/data/clone', path: 'src' });
  });

  it('lists the clone root when no path is given', async () => {
    const plugin = fakePlugin();
    await new NativeFsBackend(plugin, '/data/clone').listDir();
    expect(plugin.listDir).toHaveBeenCalledWith({ dir: '/data/clone', path: undefined });
  });

  it('proxies git diff through the scoped plugin dir', async () => {
    const plugin = fakePlugin();
    const result = await new NativeFsBackend(plugin, '/data/clone').diff();
    expect(plugin.diff).toHaveBeenCalledWith({ dir: '/data/clone' });
    expect(result.diff).toContain('diff --git');
  });

  it('searches a single file path when listing it reports not-a-directory', async () => {
    const plugin = fakePlugin();
    vi.mocked(plugin.listDir).mockResolvedValueOnce({
      entries: [],
      truncated: false,
      error: 'Not a directory: src/a.ts',
    });
    vi.mocked(plugin.readFile).mockResolvedValueOnce({
      content: 'needle\nother',
      truncated: false,
    });

    const result = await new NativeFsBackend(plugin, '/data/clone').search('needle', 'src/a.ts');

    expect(plugin.readFile).toHaveBeenCalledWith({
      dir: '/data/clone',
      path: 'src/a.ts',
      startLine: undefined,
      endLine: undefined,
    });
    expect(result.lines).toEqual(['/workspace/src/a.ts:1:needle']);
  });

  it('treats the query as a regex, matching the cloud rg/grep semantics', async () => {
    const plugin = fakePlugin();
    vi.mocked(plugin.listDir).mockResolvedValueOnce({
      entries: [],
      truncated: false,
      error: 'Not a directory: src/a.ts',
    });
    vi.mocked(plugin.readFile).mockResolvedValueOnce({
      content: 'foo here\nbar there\nneither',
      truncated: false,
    });

    const result = await new NativeFsBackend(plugin, '/data/clone').search('foo|bar', 'src/a.ts');

    expect(result.lines).toEqual([
      '/workspace/src/a.ts:1:foo here',
      '/workspace/src/a.ts:2:bar there',
    ]);
  });

  it('falls back to literal matching when the query is not a valid regex', async () => {
    const plugin = fakePlugin();
    vi.mocked(plugin.listDir).mockResolvedValueOnce({
      entries: [],
      truncated: false,
      error: 'Not a directory: src/a.ts',
    });
    vi.mocked(plugin.readFile).mockResolvedValueOnce({
      content: 'call fn( now\nno paren',
      truncated: false,
    });

    // `fn(` doesn't compile as a regex — literal fallback should still match.
    const result = await new NativeFsBackend(plugin, '/data/clone').search('fn(', 'src/a.ts');

    expect(result.lines).toEqual(['/workspace/src/a.ts:1:call fn( now']);
  });

  it('surfaces an error when the search path is neither a readable dir nor file', async () => {
    const plugin = fakePlugin();
    vi.mocked(plugin.listDir).mockResolvedValueOnce({
      entries: [],
      truncated: false,
      error: 'No such directory: nope',
    });
    vi.mocked(plugin.readFile).mockResolvedValueOnce({
      content: '',
      truncated: false,
      error: 'No such file: nope',
      code: 'ENOENT',
    });

    const result = await new NativeFsBackend(plugin, '/data/clone').search('needle', 'nope');

    // A bad path must NOT read as a clean "No matches" — the rg transport
    // errors on nonexistent paths and native should too.
    expect(result.lines).toEqual([]);
    expect(result.error).toContain('not a readable directory or file');
  });

  it("skips node_modules and top-level .gitignore'd dirs during the walk", async () => {
    const plugin = fakePlugin();
    const listings: Record<string, { name: string; type: 'file' | 'directory' }[]> = {
      '': [
        { name: 'node_modules', type: 'directory' },
        { name: 'dist', type: 'directory' },
        { name: 'src', type: 'directory' },
        { name: '.gitignore', type: 'file' },
      ],
      src: [{ name: 'a.ts', type: 'file' }],
    };
    vi.mocked(plugin.listDir).mockImplementation(async ({ path }: { path?: string }) => {
      const entries = listings[path ?? ''];
      if (!entries) return { entries: [], truncated: false, error: `unexpected listDir: ${path}` };
      return { entries, truncated: false };
    });
    vi.mocked(plugin.readFile).mockImplementation(async ({ path }: { path: string }) => {
      if (path === '.gitignore') return { content: 'dist/\n# comment\n', truncated: false };
      if (path === 'src/a.ts') return { content: 'needle here', truncated: false };
      return { content: '', truncated: false, error: `unexpected read: ${path}` };
    });

    const result = await new NativeFsBackend(plugin, '/data/clone').search('needle');

    expect(result.error).toBeUndefined();
    expect(result.lines).toEqual(['/workspace/src/a.ts:1:needle here']);
    // Neither ignored dir was ever listed — no bridge I/O into them.
    const listedPaths = vi.mocked(plugin.listDir).mock.calls.map(([arg]) => arg.path);
    expect(listedPaths).not.toContain('node_modules');
    expect(listedPaths).not.toContain('dist');
  });
});

describe('resolveNativeFs', () => {
  const ready: ResolveNativeFsDeps = {
    isNative: () => true,
    isEnabled: () => true,
    workingCopyDir: () => '/data/clone',
    plugin: fakePlugin(),
  };

  it('returns a backend when native, flagged, and a clone is ready', () => {
    expect(resolveNativeFs(scope, ready)).toBeInstanceOf(NativeFsBackend);
  });

  it('is null off the native platform', () => {
    expect(resolveNativeFs(scope, { ...ready, isNative: () => false })).toBeNull();
  });

  it('is null when the flag is off', () => {
    expect(resolveNativeFs(scope, { ...ready, isEnabled: () => false })).toBeNull();
  });

  it('is null with no scope', () => {
    expect(resolveNativeFs(undefined, ready)).toBeNull();
  });

  it('is null when the clone is not ready (falls through to sandbox)', () => {
    expect(resolveNativeFs(scope, { ...ready, workingCopyDir: () => undefined })).toBeNull();
  });
});
