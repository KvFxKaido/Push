import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePatchCardData } from '@push/lib/protocol-schema';

const { mockExecInSandbox, mockWriteToSandbox } = vi.hoisted(() => ({
  mockExecInSandbox: vi.fn(),
  mockWriteToSandbox: vi.fn(),
}));

vi.mock('./sandbox-client', () => ({
  execInSandbox: (...args: unknown[]) => mockExecInSandbox(...args),
  writeToSandbox: (...args: unknown[]) => mockWriteToSandbox(...args),
}));

const { replayWorkspacePatch } = await import('./sandbox-patch');

function makeCard(overrides: Partial<WorkspacePatchCardData> = {}): WorkspacePatchCardData {
  return {
    schemaVersion: 1,
    repoFullName: 'kvfxkaido/push',
    branch: 'feature/x',
    baseSha: 'base-sha-001',
    diffBytes: 'diff --git a/x b/x\n+new\n',
    truncated: false,
    capturedAt: 1_712_345_678_901,
    applyState: { kind: 'pending' },
    ...overrides,
  };
}

function ok(stdout = '', stderr = '') {
  return { ok: true, stdout, stderr, exitCode: 0 };
}

afterEach(() => {
  mockExecInSandbox.mockReset();
  mockWriteToSandbox.mockReset();
});

describe('replayWorkspacePatch — pre-flight refusals', () => {
  it('refuses when card.truncated === true (without touching the sandbox)', async () => {
    const state = await replayWorkspacePatch('sb-1', makeCard({ truncated: true }));
    expect(state).toEqual({ kind: 'refused', reason: 'truncated' });
    expect(mockWriteToSandbox).not.toHaveBeenCalled();
    expect(mockExecInSandbox).not.toHaveBeenCalled();
  });

  it('refuses when the diff carries a placeholder binary marker', async () => {
    const placeholderDiff =
      'diff --git a/img b/img\nindex aaa..bbb 100644\nBinary files a/img and b/img differ\n';
    const state = await replayWorkspacePatch('sb-1', makeCard({ diffBytes: placeholderDiff }));
    expect(state).toEqual({ kind: 'refused', reason: 'binary-placeholder' });
    expect(mockWriteToSandbox).not.toHaveBeenCalled();
  });

  it('accepts a full GIT-binary-patch block (not a placeholder)', async () => {
    // Has both "Binary files" *and* "GIT binary patch" → legit --binary
    // output, replayable. Should not short-circuit as refused.
    const realBinaryDiff =
      'diff --git a/img b/img\nindex aaa..bbb 100644\nGIT binary patch\nliteral 4\nzc${...}\n';
    mockWriteToSandbox.mockResolvedValue(ok());
    // Reverse-check fails (not already applied), HEAD matches, apply succeeds.
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'base-sha-001\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // apply

    const state = await replayWorkspacePatch('sb-1', makeCard({ diffBytes: realBinaryDiff }));
    expect(state.kind).toBe('applied');
  });
});

describe('replayWorkspacePatch — write failure', () => {
  it("returns conflict when the patch can't be staged", async () => {
    mockWriteToSandbox.mockResolvedValue({ ok: false, error: 'disk full' });
    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state).toMatchObject({ kind: 'conflict' });
    if (state.kind === 'conflict') {
      expect(state.detail).toContain('Failed to stage patch: disk full');
    }
  });
});

describe('replayWorkspacePatch — reverse-check (already applied)', () => {
  it("returns applied with note='already-applied' when the patch reverses cleanly", async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // reverse-check

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state).toMatchObject({ kind: 'applied', note: 'already-applied' });
    if (state.kind === 'applied') {
      expect(state.appliedAt).toEqual(expect.any(Number));
    }
    // Only one exec call (reverse-check) — no rev-parse, no apply.
    expect(mockExecInSandbox).toHaveBeenCalledTimes(1);
  });
});

describe('replayWorkspacePatch — HEAD matches baseSha (direct apply)', () => {
  it('returns applied on a clean apply', async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check (no)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'base-sha-001\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // apply

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state).toMatchObject({ kind: 'applied' });
    // Direct apply call should NOT use --3way.
    const applyCmd = mockExecInSandbox.mock.calls[2][1] as string;
    expect(applyCmd).toContain('git apply --whitespace=nowarn');
    expect(applyCmd).not.toContain('--3way');
  });

  it('returns conflict with stderr when direct apply fails', async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'base-sha-001\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'error: patch failed: x:1\nerror: x: patch does not apply\n',
      });

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state.kind).toBe('conflict');
    if (state.kind === 'conflict') {
      expect(state.detail).toContain('patch does not apply');
    }
  });
});

describe('replayWorkspacePatch — HEAD differs from baseSha (3-way)', () => {
  it('returns applied when 3-way merges cleanly', async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'new-head-sha\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // 3-way apply

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state.kind).toBe('applied');
    const applyCmd = mockExecInSandbox.mock.calls[2][1] as string;
    expect(applyCmd).toContain('--3way');
  });

  it('returns conflict when 3-way produces a resolvable conflict', async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'new-head-sha\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Applied patch to file.ts with conflicts.\nU file.ts\n',
      });

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state.kind).toBe('conflict');
    if (state.kind === 'conflict') {
      expect(state.detail).toContain('with conflicts');
    }
  });

  it("returns refused('base-mismatch') when 3-way can't merge at all", async () => {
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'new-head-sha\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        // Base commit unreachable — no "with conflicts" in output.
        stderr:
          'error: sha1 information is lacking or useless (file.ts).\nerror: could not build fake ancestor\n',
      });

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state).toEqual({ kind: 'refused', reason: 'base-mismatch' });
  });
});

describe('replayWorkspacePatch — empty rev-parse output', () => {
  it('falls through to 3-way when HEAD lookup is empty', async () => {
    // If git rev-parse can't read HEAD we don't have a base to compare,
    // so treat it as mismatch and route through 3-way (which will likely
    // refuse, but it's the right path).
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // reverse-check
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rev-parse empty
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // 3-way succeeds

    const state = await replayWorkspacePatch('sb-1', makeCard());
    expect(state.kind).toBe('applied');
    const applyCmd = mockExecInSandbox.mock.calls[2][1] as string;
    expect(applyCmd).toContain('--3way');
  });
});

describe('replayWorkspacePatch — detail truncation', () => {
  it('clamps conflict.detail to 1000 chars + truncation marker', async () => {
    const longStderr = 'x'.repeat(5000);
    mockWriteToSandbox.mockResolvedValue(ok());
    mockExecInSandbox
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'base-sha-001\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: longStderr });

    const state = await replayWorkspacePatch('sb-1', makeCard());
    if (state.kind !== 'conflict') {
      throw new Error(`expected conflict, got ${state.kind}`);
    }
    expect(state.detail.length).toBeLessThanOrEqual(1100);
    expect(state.detail).toContain('…[truncated]');
  });
});
