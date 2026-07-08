import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ensureWorkingCopy,
  forgetWorkingCopy,
  rekeyWorkingCopyScope,
  workingCopyDir,
  workingCopyPath,
  __resetWorkingCopyRegistryForTests,
  type WorkingCopyScope,
} from './native-working-copy';

const scope: WorkingCopyScope = { repoFullName: 'owner/repo', branch: 'main' };

beforeEach(() => {
  __resetWorkingCopyRegistryForTests();
});

describe('workingCopyPath', () => {
  it('keys under worktrees/ via the collision-free lane scheme', () => {
    expect(workingCopyPath(scope)).toMatch(/^worktrees\/owner_repo-[0-9a-f]{8}\/main-[0-9a-f]{8}$/);
  });

  it('distinguishes branches that sanitize identically', () => {
    // `feat/x` and `feat:x` both sanitize to `feat_x`; the hash must disambiguate
    // so two branches never share one on-device dir (the checkpoint-store P1).
    const a = workingCopyPath({ repoFullName: 'o/r', branch: 'feat/x' });
    const b = workingCopyPath({ repoFullName: 'o/r', branch: 'feat:x' });
    expect(a).not.toBe(b);
  });
});

describe('workingCopyDir', () => {
  it('is undefined before any clone is registered', () => {
    expect(workingCopyDir(scope)).toBeUndefined();
  });

  it('is undefined while cloning, then the dir once ready', async () => {
    let resolveClone!: (r: { ok: boolean }) => void;
    const clone = vi.fn(() => new Promise<{ ok: boolean }>((r) => (resolveClone = r)));

    const pending = ensureWorkingCopy(scope, { clone, log: () => {} });
    // Mid-clone: the seam must NOT hand out a half-cloned repo.
    expect(workingCopyDir(scope)).toBeUndefined();

    resolveClone({ ok: true });
    await pending;
    expect(workingCopyDir(scope)).toBe(workingCopyPath(scope));
  });

  it('stays undefined when the clone failed', async () => {
    const clone = vi.fn(async () => ({ ok: false, message: 'no network' }));
    await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(workingCopyDir(scope)).toBeUndefined();
  });
});

describe('rekeyWorkingCopyScope', () => {
  it('moves a ready registry entry to the new branch key while preserving the clone dir', async () => {
    const clone = vi.fn(async () => ({ ok: true }));
    await ensureWorkingCopy(scope, { clone, log: () => {} });

    const nextScope: WorkingCopyScope = { repoFullName: 'owner/repo', branch: 'feature/native' };
    const log = vi.fn();

    expect(rekeyWorkingCopyScope(scope, nextScope, { log })).toBe(true);
    expect(workingCopyDir(scope)).toBeUndefined();
    expect(workingCopyDir(nextScope)).toBe(workingCopyPath(scope));
    expect(log).toHaveBeenCalledWith(
      'info',
      'native_working_copy_rekeyed',
      expect.objectContaining({
        repo: 'owner/repo',
        fromBranch: 'main',
        toBranch: 'feature/native',
        dir: workingCopyPath(scope),
      }),
    );
  });

  it('returns false when the source scope is not ready', () => {
    const nextScope: WorkingCopyScope = { repoFullName: 'owner/repo', branch: 'feature/native' };
    expect(rekeyWorkingCopyScope(scope, nextScope, { log: () => {} })).toBe(false);
    expect(workingCopyDir(nextScope)).toBeUndefined();
  });
});

describe('ensureWorkingCopy', () => {
  it('clones with the GitHub HTTPS url, branch, token, and depth', async () => {
    const clone = vi.fn(async () => ({ ok: true }));
    await ensureWorkingCopy(scope, {
      clone,
      getToken: () => 'tok_123',
      depth: 1,
      log: () => {},
    });
    expect(clone).toHaveBeenCalledWith({
      url: 'https://github.com/owner/repo.git',
      dir: workingCopyPath(scope),
      branch: 'main',
      token: 'tok_123',
      depth: 1,
    });
  });

  it('resolves to a ready state on success', async () => {
    const clone = vi.fn(async () => ({ ok: true }));
    const state = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(state).toEqual({ status: 'ready', dir: workingCopyPath(scope) });
  });

  it('resolves to a failed state (never rejects) on a clone error', async () => {
    const clone = vi.fn(async () => ({ ok: false, message: 'auth failed' }));
    const state = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(state).toEqual({
      status: 'failed',
      dir: workingCopyPath(scope),
      message: 'auth failed',
    });
  });

  it('resolves to a failed state when the clone throws', async () => {
    const clone = vi.fn(async () => {
      throw new Error('plugin boom');
    });
    const state = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(state.status).toBe('failed');
    expect(state.message).toBe('plugin boom');
  });

  it('dedupes concurrent calls onto one in-flight clone', async () => {
    let resolveClone!: (r: { ok: boolean }) => void;
    const clone = vi.fn(() => new Promise<{ ok: boolean }>((r) => (resolveClone = r)));

    const a = ensureWorkingCopy(scope, { clone, log: () => {} });
    const b = ensureWorkingCopy(scope, { clone, log: () => {} });
    resolveClone({ ok: true });
    await Promise.all([a, b]);

    // One clone, not two — the second call rode the first's promise.
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it('reuses a ready clone without re-cloning', async () => {
    const clone = vi.fn(async () => ({ ok: true }));
    await ensureWorkingCopy(scope, { clone, log: () => {} });
    const state = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('ready');
  });

  it('re-attempts after a failure', async () => {
    const clone = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'transient' })
      .mockResolvedValueOnce({ ok: true });
    const first = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(first.status).toBe('failed');
    const second = await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(second.status).toBe('ready');
    expect(clone).toHaveBeenCalledTimes(2);
  });

  it('emits paired lifecycle logs (started ↔ ready, started ↔ failed, reused)', async () => {
    const log = vi.fn();
    const okClone = vi.fn(async () => ({ ok: true }));
    await ensureWorkingCopy(scope, { clone: okClone, log });
    await ensureWorkingCopy(scope, { clone: okClone, log });
    const events = log.mock.calls.map((c) => c[1]);
    expect(events).toEqual(['native_clone_started', 'native_clone_ready', 'native_clone_reused']);

    const failScope: WorkingCopyScope = { repoFullName: 'o/r', branch: 'bad' };
    const failLog = vi.fn();
    await ensureWorkingCopy(failScope, {
      clone: async () => ({ ok: false, message: 'x' }),
      log: failLog,
    });
    expect(failLog.mock.calls.map((c) => c[1])).toEqual([
      'native_clone_started',
      'native_clone_failed',
    ]);
  });
});

describe('forgetWorkingCopy', () => {
  it('drops the registry entry so the seam falls back', async () => {
    const clone = vi.fn(async () => ({ ok: true }));
    await ensureWorkingCopy(scope, { clone, log: () => {} });
    expect(workingCopyDir(scope)).toBeDefined();

    expect(forgetWorkingCopy(scope, { log: () => {} })).toBe(true);
    expect(workingCopyDir(scope)).toBeUndefined();
  });

  it('returns false when nothing was registered', () => {
    expect(forgetWorkingCopy(scope, { log: () => {} })).toBe(false);
  });
});
