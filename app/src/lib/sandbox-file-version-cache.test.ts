import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  onWorkspaceMutation,
  setSandboxWorkspaceRevision,
  getSandboxWorkspaceRevision,
  clearSandboxWorkspaceRevision,
} from './sandbox-file-version-cache';

describe('onWorkspaceMutation (B2 mutation signal)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
    clearSandboxWorkspaceRevision();
  });
  function sub(fn: (id: string, rev: number) => void) {
    const off = onWorkspaceMutation(fn);
    cleanups.push(off);
    return off;
  }

  it('fires on the first revision and on increases (mutations)', () => {
    const seen: Array<[string, number]> = [];
    sub((id, rev) => seen.push([id, rev]));
    setSandboxWorkspaceRevision('sb-1', 1); // first → fire
    setSandboxWorkspaceRevision('sb-1', 2); // increase → fire
    expect(seen).toEqual([
      ['sb-1', 1],
      ['sb-1', 2],
    ]);
  });

  it('does NOT fire when the revision is unchanged (read-only exec)', () => {
    const fn = vi.fn();
    setSandboxWorkspaceRevision('sb-1', 5);
    sub(fn);
    setSandboxWorkspaceRevision('sb-1', 5); // same → no mutation
    expect(fn).not.toHaveBeenCalled();
    expect(getSandboxWorkspaceRevision('sb-1')).toBe(5);
  });

  it('does NOT fire when the revision goes backwards (reset/race)', () => {
    const fn = vi.fn();
    setSandboxWorkspaceRevision('sb-1', 5);
    sub(fn);
    setSandboxWorkspaceRevision('sb-1', 3); // lower → not a mutation signal
    expect(fn).not.toHaveBeenCalled();
    // …but the value is still recorded.
    expect(getSandboxWorkspaceRevision('sb-1')).toBe(3);
  });

  it('stops firing after unsubscribe', () => {
    const fn = vi.fn();
    const off = sub(fn);
    setSandboxWorkspaceRevision('sb-1', 1);
    off();
    setSandboxWorkspaceRevision('sb-1', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener never breaks revision tracking', () => {
    sub(() => {
      throw new Error('observer blew up');
    });
    const ok = vi.fn();
    sub(ok);
    expect(() => setSandboxWorkspaceRevision('sb-1', 1)).not.toThrow();
    expect(getSandboxWorkspaceRevision('sb-1')).toBe(1);
    expect(ok).toHaveBeenCalledWith('sb-1', 1);
  });
});
