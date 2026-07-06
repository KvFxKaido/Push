import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getActiveGitBackend,
  resolveActiveGitBinding,
  resolveGitBackend,
  type GitSessionBinding,
} from './git-session';

// Stub the two backend factories so the seam's dispatch is observable without
// constructing real sandbox/native backends.
vi.mock('./git-backend', () => ({
  createSandboxGitBackend: vi.fn((sandboxId: string) => ({ tag: 'sandbox', sandboxId })),
}));
vi.mock('./native-git', () => ({
  createNativeGitBackend: vi.fn((opts: { dir: string }) => ({ tag: 'native', dir: opts.dir })),
}));
vi.mock('./github-auth', () => ({
  getActiveGitHubToken: vi.fn(() => 'tok_default'),
}));

import { createSandboxGitBackend } from './git-backend';
import { createNativeGitBackend } from './native-git';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveGitBackend dispatch', () => {
  it('routes a sandbox binding to the sandbox factory', () => {
    const backend = resolveGitBackend({ kind: 'sandbox', sandboxId: 'sb_1' }) as unknown as {
      tag: string;
      sandboxId: string;
    };
    expect(backend).toEqual({ tag: 'sandbox', sandboxId: 'sb_1' });
    expect(createSandboxGitBackend).toHaveBeenCalledWith('sb_1');
    expect(createNativeGitBackend).not.toHaveBeenCalled();
  });

  it('routes a native binding to the native factory with a token provider', () => {
    const backend = resolveGitBackend({ kind: 'native', dir: '/data/clone' }) as unknown as {
      tag: string;
      dir: string;
    };
    expect(backend).toEqual({ tag: 'native', dir: '/data/clone' });
    expect(createNativeGitBackend).toHaveBeenCalledTimes(1);
    const opts = (createNativeGitBackend as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.dir).toBe('/data/clone');
    // Default provider adapts the active GitHub token to `string | undefined`.
    expect(opts.getToken()).toBe('tok_default');
  });

  it('lets a caller inject the native token provider', () => {
    resolveGitBackend({ kind: 'native', dir: '/d' }, { getNativeToken: () => 'tok_custom' });
    const opts = (createNativeGitBackend as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.getToken()).toBe('tok_custom');
  });
});

describe('resolveActiveGitBinding platform selection', () => {
  it('returns a sandbox binding on web (non-native)', () => {
    const binding = resolveActiveGitBinding({ sandboxId: 'sb_9' }, { isNative: () => false });
    expect(binding).toEqual({ kind: 'sandbox', sandboxId: 'sb_9' });
  });

  it('returns a sandbox binding on native when no working copy is registered (dormant arm)', () => {
    const binding = resolveActiveGitBinding(
      { sandboxId: 'sb_9', repoFullName: 'owner/repo', branch: 'main' },
      { isNative: () => true, nativeWorkingCopyDir: () => undefined },
    );
    expect(binding).toEqual({ kind: 'sandbox', sandboxId: 'sb_9' });
  });

  it('returns a native binding on native once a working copy is registered', () => {
    const binding = resolveActiveGitBinding(
      { sandboxId: 'sb_9', repoFullName: 'owner/repo', branch: 'main' },
      { isNative: () => true, nativeWorkingCopyDir: () => '/data/owner-repo' },
    );
    expect(binding).toEqual({ kind: 'native', dir: '/data/owner-repo' });
  });

  it('keys the working-copy lookup on the durable scope (repoFullName + branch)', () => {
    const lookup = vi.fn((s: { repoFullName?: string; branch?: string }) =>
      `/data/${s.repoFullName}@${s.branch}`.replace(/\//g, '-'),
    );
    const binding = resolveActiveGitBinding(
      { sandboxId: 'sb_9', repoFullName: 'owner/repo', branch: 'feat/x' },
      { isNative: () => true, nativeWorkingCopyDir: lookup },
    );
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'owner/repo', branch: 'feat/x' }),
    );
    expect(binding).toEqual({ kind: 'native', dir: '-data-owner-repo@feat-x' });
  });

  it('falls through to sandbox (never calls the lookup) when a native ref omits the scope', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = vi.fn(() => '/should-not-be-used');
    const binding = resolveActiveGitBinding(
      { sandboxId: 'sb_9' },
      { isNative: () => true, nativeWorkingCopyDir: lookup },
    );
    expect(binding).toEqual({ kind: 'sandbox', sandboxId: 'sb_9' });
    expect(lookup).not.toHaveBeenCalled();
    // The unscoped-native fall-through is a defect, not a transient — it logs.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('native_git_binding_unscoped'));
    warn.mockRestore();
  });

  it('defaults to the real platform probe (sandbox under the test/jsdom runtime)', () => {
    const binding = resolveActiveGitBinding({ sandboxId: 'sb_real' });
    expect(binding).toEqual({ kind: 'sandbox', sandboxId: 'sb_real' });
  });
});

describe('getActiveGitBackend end-to-end', () => {
  it('resolves binding then dispatches in one call', () => {
    getActiveGitBackend(
      { sandboxId: 'sb_e2e', repoFullName: 'owner/repo', branch: 'main' },
      { isNative: () => true, nativeWorkingCopyDir: () => '/clone' },
    );
    const opts = (createNativeGitBackend as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.dir).toBe('/clone');
    expect(createSandboxGitBackend).not.toHaveBeenCalled();
  });

  it('falls through to sandbox on web', () => {
    getActiveGitBackend({ sandboxId: 'sb_web' }, { isNative: () => false });
    expect(createSandboxGitBackend).toHaveBeenCalledWith('sb_web');
  });

  // Type-level guard: the binding union stays exhaustive. A new `kind` makes
  // this fail to compile (the switch in resolveGitBackend has no default).
  it('binding union shape', () => {
    const sandbox: GitSessionBinding = { kind: 'sandbox', sandboxId: 'x' };
    const native: GitSessionBinding = { kind: 'native', dir: '/x' };
    expect(sandbox.kind).toBe('sandbox');
    expect(native.kind).toBe('native');
  });
});
