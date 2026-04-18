import { describe, expect, it, vi } from 'vitest';
import {
  handleApplyPatchset,
  handleWriteFile,
  type WriteHandlerContext,
} from './sandbox-write-handlers';
import type { BatchWriteResult, ExecResult, FileReadResult, WriteResult } from './sandbox-client';
import type { EditGuardVerdict, FileState, MutationProvenance } from './file-awareness-ledger';

const okExec = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

const allowVerdict: EditGuardVerdict = { allowed: true };

interface MakeContextOpts {
  readResults?: FileReadResult[];
  writeResult?: WriteResult;
  batchResult?: BatchWriteResult;
  execResult?: ExecResult;
  writeAllowedVerdict?: EditGuardVerdict;
  symbolicVerdict?: EditGuardVerdict;
  ledgerState?: FileState;
  provenance?: MutationProvenance;
  staleWarning?: string | null;
}

function makeContext(opts: MakeContextOpts = {}): WriteHandlerContext & {
  readFromSandbox: ReturnType<typeof vi.fn>;
  writeToSandbox: ReturnType<typeof vi.fn>;
  batchWriteToSandbox: ReturnType<typeof vi.fn>;
  execInSandbox: ReturnType<typeof vi.fn>;
  versionCacheGet: ReturnType<typeof vi.fn>;
  versionCacheSet: ReturnType<typeof vi.fn>;
  versionCacheDelete: ReturnType<typeof vi.fn>;
  versionCacheDeletePath: ReturnType<typeof vi.fn>;
  getWorkspaceRevisionByKey: ReturnType<typeof vi.fn>;
  setSandboxWorkspaceRevision: ReturnType<typeof vi.fn>;
  setWorkspaceRevisionByKey: ReturnType<typeof vi.fn>;
  syncReadSnapshot: ReturnType<typeof vi.fn>;
  invalidateWorkspaceSnapshots: ReturnType<typeof vi.fn>;
  recordLedgerRead: ReturnType<typeof vi.fn>;
  recordLedgerAutoExpandAttempt: ReturnType<typeof vi.fn>;
  recordLedgerAutoExpandSuccess: ReturnType<typeof vi.fn>;
  recordLedgerSymbolAutoExpand: ReturnType<typeof vi.fn>;
  recordLedgerSymbolWarningSoftened: ReturnType<typeof vi.fn>;
  recordLedgerCreation: ReturnType<typeof vi.fn>;
  recordLedgerMutation: ReturnType<typeof vi.fn>;
  markLedgerStale: ReturnType<typeof vi.fn>;
  getLedgerStaleWarning: ReturnType<typeof vi.fn>;
  getLedgerState: ReturnType<typeof vi.fn>;
  getLedgerProvenance: ReturnType<typeof vi.fn>;
  restoreLedgerState: ReturnType<typeof vi.fn>;
  clearLedgerProvenance: ReturnType<typeof vi.fn>;
  checkWriteAllowed: ReturnType<typeof vi.fn>;
  checkSymbolicEditAllowed: ReturnType<typeof vi.fn>;
  checkLinesCovered: ReturnType<typeof vi.fn>;
  invalidateSymbolLedger: ReturnType<typeof vi.fn>;
  recordWriteFileMetric: ReturnType<typeof vi.fn>;
} {
  const reads = opts.readResults ?? [{ content: '', truncated: false }];
  let readIdx = 0;
  return {
    sandboxId: 'sb-1',
    readFromSandbox: vi.fn(async () => reads[Math.min(readIdx++, reads.length - 1)]),
    writeToSandbox: vi.fn(
      async (): Promise<WriteResult> =>
        opts.writeResult ?? { ok: true, new_version: 'v2', bytes_written: 10 },
    ),
    batchWriteToSandbox: vi.fn(
      async (): Promise<BatchWriteResult> =>
        opts.batchResult ?? { ok: true, results: [], workspace_revision: 2 },
    ),
    execInSandbox: vi.fn(async () => opts.execResult ?? okExec()),
    versionCacheGet: vi.fn(() => undefined),
    versionCacheSet: vi.fn(),
    versionCacheDelete: vi.fn(),
    versionCacheDeletePath: vi.fn(),
    getWorkspaceRevisionByKey: vi.fn(() => undefined),
    setSandboxWorkspaceRevision: vi.fn(),
    setWorkspaceRevisionByKey: vi.fn(),
    syncReadSnapshot: vi.fn(),
    invalidateWorkspaceSnapshots: vi.fn(() => 0),
    recordLedgerRead: vi.fn(),
    recordLedgerAutoExpandAttempt: vi.fn(),
    recordLedgerAutoExpandSuccess: vi.fn(),
    recordLedgerSymbolAutoExpand: vi.fn(),
    recordLedgerSymbolWarningSoftened: vi.fn(),
    recordLedgerCreation: vi.fn(),
    recordLedgerMutation: vi.fn(),
    markLedgerStale: vi.fn(),
    getLedgerStaleWarning: vi.fn(() => opts.staleWarning ?? null),
    getLedgerState: vi.fn(() => opts.ledgerState),
    getLedgerProvenance: vi.fn(() => opts.provenance),
    restoreLedgerState: vi.fn(),
    clearLedgerProvenance: vi.fn(),
    checkWriteAllowed: vi.fn(() => opts.writeAllowedVerdict ?? allowVerdict),
    checkSymbolicEditAllowed: vi.fn(() => opts.symbolicVerdict ?? allowVerdict),
    checkLinesCovered: vi.fn(() => allowVerdict),
    invalidateSymbolLedger: vi.fn(),
    recordWriteFileMetric: vi.fn(),
  };
}

describe('handleWriteFile', () => {
  it('writes on guard-allowed path and records creation + mutation', async () => {
    const ctx = makeContext({
      writeResult: { ok: true, new_version: 'v2', bytes_written: 12 },
    });

    const result = await handleWriteFile(ctx, {
      path: '/workspace/src/app.ts',
      content: 'const x = 1;',
    });

    expect(ctx.writeToSandbox).toHaveBeenCalled();
    expect(ctx.recordLedgerCreation).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.recordLedgerMutation).toHaveBeenCalledWith('/workspace/src/app.ts', 'agent');
    expect(ctx.invalidateSymbolLedger).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.recordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success' }),
    );
    expect(result.text).toContain('[Tool Result — sandbox_write_file]');
    expect(result.postconditions?.touchedFiles[0]?.mutation).toBe('write');
  });

  it('surfaces stale-file write with STALE_FILE error', async () => {
    const ctx = makeContext({
      writeResult: {
        ok: false,
        code: 'STALE_FILE',
        expected_version: 'v1',
        current_version: 'v9',
      },
    });

    const result = await handleWriteFile(ctx, {
      path: '/workspace/src/app.ts',
      content: 'const x = 1;',
    });

    expect(ctx.versionCacheSet).toHaveBeenCalledWith(expect.any(String), 'v9');
    expect(ctx.markLedgerStale).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.invalidateSymbolLedger).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.recordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'stale', errorCode: 'STALE_FILE' }),
    );
    expect(result.structuredError?.type).toBe('STALE_FILE');
  });

  it('surfaces workspace-changed write with WORKSPACE_CHANGED error', async () => {
    const ctx = makeContext({
      writeResult: {
        ok: false,
        code: 'WORKSPACE_CHANGED',
        expected_workspace_revision: 5,
        current_workspace_revision: 7,
      },
    });

    const result = await handleWriteFile(ctx, {
      path: '/workspace/src/app.ts',
      content: 'const x = 1;',
    });

    expect(ctx.invalidateWorkspaceSnapshots).toHaveBeenCalledWith('sb-1', 7);
    expect(ctx.recordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'stale', errorCode: 'WORKSPACE_CHANGED' }),
    );
    expect(result.structuredError?.type).toBe('WORKSPACE_CHANGED');
  });

  it('allows new-file creation when guard blocks and auto-read reports file missing', async () => {
    const ctx = makeContext({
      writeAllowedVerdict: { allowed: false, reason: 'Unread file /workspace/src/new.ts' },
      readResults: [
        { content: '', truncated: false, error: 'ENOENT: no such file' } as FileReadResult,
      ],
      writeResult: { ok: true, new_version: 'v1', bytes_written: 5 },
    });

    const result = await handleWriteFile(ctx, {
      path: '/workspace/src/new.ts',
      content: 'hello',
    });

    expect(ctx.recordLedgerCreation).toHaveBeenCalledWith('/workspace/src/new.ts');
    expect(ctx.writeToSandbox).toHaveBeenCalled();
    expect(result.text).toContain('[Tool Result — sandbox_write_file]');
  });
});

describe('handleApplyPatchset', () => {
  it('rejects empty patchsets', async () => {
    const ctx = makeContext();
    const result = await handleApplyPatchset(ctx, { edits: [] });
    expect(result.text).toContain('No edits provided');
    expect(ctx.batchWriteToSandbox).not.toHaveBeenCalled();
  });

  it('rejects duplicate file paths', async () => {
    const ctx = makeContext();
    const result = await handleApplyPatchset(ctx, {
      edits: [
        { path: '/workspace/a.ts', ops: [{ op: 'replace_line', ref: '1:abc1234', content: 'x' }] },
        { path: '/workspace/a.ts', ops: [{ op: 'replace_line', ref: '2:def5678', content: 'y' }] },
      ],
    });
    expect(result.text).toContain('Duplicate file paths');
    expect(ctx.batchWriteToSandbox).not.toHaveBeenCalled();
  });

  it('validates dry-run without writing', async () => {
    const ctx = makeContext({
      readResults: [
        {
          content: 'const x = 1;\nconst y = 2;\n',
          version: 'v1',
          truncated: false,
        } as FileReadResult,
      ],
    });

    const result = await handleApplyPatchset(ctx, {
      edits: [
        {
          path: '/workspace/src/app.ts',
          start_line: 1,
          end_line: 1,
          content: 'const x = 99;',
        },
      ],
      dryRun: true,
    });

    expect(ctx.batchWriteToSandbox).not.toHaveBeenCalled();
    expect(result.text).toContain('(dry run)');
    expect(result.text).toContain('1 op(s) would apply');
  });
});
