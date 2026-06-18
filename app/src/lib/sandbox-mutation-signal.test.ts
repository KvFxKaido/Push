import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  onWorkspaceMutation,
  notifyWorkspaceMutation,
  shouldSignalWorkspaceMutation,
} from './sandbox-mutation-signal';

describe('onWorkspaceMutation / notifyWorkspaceMutation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
  const sub = (fn: (id: string) => void) => {
    const off = onWorkspaceMutation(fn);
    cleanups.push(off);
    return off;
  };

  it('notifies subscribers with the sandbox id', () => {
    const seen: string[] = [];
    sub((id) => seen.push(id));
    notifyWorkspaceMutation('sb-1');
    notifyWorkspaceMutation('sb-2');
    expect(seen).toEqual(['sb-1', 'sb-2']);
  });

  it('stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = sub(fn);
    notifyWorkspaceMutation('sb-1');
    off();
    notifyWorkspaceMutation('sb-1');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener never breaks dispatch or other listeners', () => {
    sub(() => {
      throw new Error('observer blew up');
    });
    const ok = vi.fn();
    sub(ok);
    expect(() => notifyWorkspaceMutation('sb-1')).not.toThrow();
    expect(ok).toHaveBeenCalledWith('sb-1');
  });
});

describe('shouldSignalWorkspaceMutation', () => {
  it('fires for any file-mutation tool', () => {
    expect(
      shouldSignalWorkspaceMutation(true, {
        isExec: false,
        execIsMutating: false,
      }),
    ).toBe(true);
  });

  it('fires for a mutating exec, not a read-only one', () => {
    expect(shouldSignalWorkspaceMutation(false, { isExec: true, execIsMutating: true })).toBe(true);
    expect(shouldSignalWorkspaceMutation(false, { isExec: true, execIsMutating: false })).toBe(
      false,
    );
  });

  it('does NOT fire for a non-file-mutation, non-exec tool (reads, push, commit, branch ops)', () => {
    // These reach dispatch as non-file-mutation tools that aren't sandbox_exec,
    // so they never signal a working-tree mutation.
    expect(shouldSignalWorkspaceMutation(false, { isExec: false, execIsMutating: false })).toBe(
      false,
    );
  });
});
