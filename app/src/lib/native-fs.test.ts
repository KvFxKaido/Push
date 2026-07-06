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
