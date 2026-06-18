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
  const opts = (o: Partial<Parameters<typeof shouldSignalWorkspaceMutation>[1]>) => ({
    isFileMutationTool: false,
    isExec: false,
    execIsMutating: false,
    ...o,
  });

  it('fires for any file-mutation tool', () => {
    expect(
      shouldSignalWorkspaceMutation('sandbox_write_file', opts({ isFileMutationTool: true })),
    ).toBe(true);
  });

  it('fires for command-running tools that can touch tracked files', () => {
    // verification (lockfile from npm install) + prepare_commit (pre-commit
    // hook can rewrite tracked files before the audit).
    for (const t of [
      'sandbox_run_tests',
      'sandbox_check_types',
      'sandbox_verify_workspace',
      'sandbox_prepare_commit',
    ]) {
      expect(shouldSignalWorkspaceMutation(t, opts({}))).toBe(true);
    }
  });

  it('fires for a mutating exec, not a read-only one', () => {
    expect(
      shouldSignalWorkspaceMutation('sandbox_exec', opts({ isExec: true, execIsMutating: true })),
    ).toBe(true);
    expect(
      shouldSignalWorkspaceMutation('sandbox_exec', opts({ isExec: true, execIsMutating: false })),
    ).toBe(false);
  });

  it('does NOT fire for reads, push, branch ops, diff', () => {
    for (const t of ['sandbox_read_file', 'sandbox_push', 'sandbox_diff', 'sandbox_list_dir']) {
      expect(shouldSignalWorkspaceMutation(t, opts({}))).toBe(false);
    }
  });
});
