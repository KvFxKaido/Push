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
  readFromSandbox: ReturnType<typeof vi.fn<WriteHandlerContext['readFromSandbox']>>;
  writeToSandbox: ReturnType<typeof vi.fn<WriteHandlerContext['writeToSandbox']>>;
  batchWriteToSandbox: ReturnType<typeof vi.fn<WriteHandlerContext['batchWriteToSandbox']>>;
  execInSandbox: ReturnType<typeof vi.fn<WriteHandlerContext['execInSandbox']>>;
  versionCacheGet: ReturnType<typeof vi.fn<WriteHandlerContext['versionCacheGet']>>;
  versionCacheSet: ReturnType<typeof vi.fn<WriteHandlerContext['versionCacheSet']>>;
  versionCacheDelete: ReturnType<typeof vi.fn<WriteHandlerContext['versionCacheDelete']>>;
  versionCacheDeletePath: ReturnType<typeof vi.fn<WriteHandlerContext['versionCacheDeletePath']>>;
  getWorkspaceRevisionByKey: ReturnType<
    typeof vi.fn<WriteHandlerContext['getWorkspaceRevisionByKey']>
  >;
  setSandboxWorkspaceRevision: ReturnType<
    typeof vi.fn<WriteHandlerContext['setSandboxWorkspaceRevision']>
  >;
  setWorkspaceRevisionByKey: ReturnType<
    typeof vi.fn<WriteHandlerContext['setWorkspaceRevisionByKey']>
  >;
  syncReadSnapshot: ReturnType<typeof vi.fn<WriteHandlerContext['syncReadSnapshot']>>;
  invalidateWorkspaceSnapshots: ReturnType<
    typeof vi.fn<WriteHandlerContext['invalidateWorkspaceSnapshots']>
  >;
  recordLedgerRead: ReturnType<typeof vi.fn<WriteHandlerContext['recordLedgerRead']>>;
  recordLedgerAutoExpandAttempt: ReturnType<
    typeof vi.fn<WriteHandlerContext['recordLedgerAutoExpandAttempt']>
  >;
  recordLedgerAutoExpandSuccess: ReturnType<
    typeof vi.fn<WriteHandlerContext['recordLedgerAutoExpandSuccess']>
  >;
  recordLedgerSymbolAutoExpand: ReturnType<
    typeof vi.fn<WriteHandlerContext['recordLedgerSymbolAutoExpand']>
  >;
  recordLedgerSymbolWarningSoftened: ReturnType<
    typeof vi.fn<WriteHandlerContext['recordLedgerSymbolWarningSoftened']>
  >;
  recordLedgerCreation: ReturnType<typeof vi.fn<WriteHandlerContext['recordLedgerCreation']>>;
  recordLedgerMutation: ReturnType<typeof vi.fn<WriteHandlerContext['recordLedgerMutation']>>;
  markLedgerStale: ReturnType<typeof vi.fn<WriteHandlerContext['markLedgerStale']>>;
  getLedgerStaleWarning: ReturnType<typeof vi.fn<WriteHandlerContext['getLedgerStaleWarning']>>;
  getLedgerState: ReturnType<typeof vi.fn<WriteHandlerContext['getLedgerState']>>;
  getLedgerProvenance: ReturnType<typeof vi.fn<WriteHandlerContext['getLedgerProvenance']>>;
  restoreLedgerState: ReturnType<typeof vi.fn<WriteHandlerContext['restoreLedgerState']>>;
  clearLedgerProvenance: ReturnType<typeof vi.fn<WriteHandlerContext['clearLedgerProvenance']>>;
  checkWriteAllowed: ReturnType<typeof vi.fn<WriteHandlerContext['checkWriteAllowed']>>;
  checkSymbolicEditAllowed: ReturnType<
    typeof vi.fn<WriteHandlerContext['checkSymbolicEditAllowed']>
  >;
  checkLinesCovered: ReturnType<typeof vi.fn<WriteHandlerContext['checkLinesCovered']>>;
  invalidateSymbolLedger: ReturnType<typeof vi.fn<WriteHandlerContext['invalidateSymbolLedger']>>;
  recordWriteFileMetric: ReturnType<typeof vi.fn<WriteHandlerContext['recordWriteFileMetric']>>;
} {
  const reads = opts.readResults ?? [{ content: '', truncated: false }];
  let readIdx = 0;
  return {
    sandboxId: 'sb-1',
    readFromSandbox: vi.fn<WriteHandlerContext['readFromSandbox']>(
      async () => reads[Math.min(readIdx++, reads.length - 1)],
    ),
    writeToSandbox: vi.fn<WriteHandlerContext['writeToSandbox']>(
      async (): Promise<WriteResult> =>
        opts.writeResult ?? { ok: true, new_version: 'v2', bytes_written: 10 },
    ),
    batchWriteToSandbox: vi.fn<WriteHandlerContext['batchWriteToSandbox']>(
      async (): Promise<BatchWriteResult> =>
        opts.batchResult ?? { ok: true, results: [], workspace_revision: 2 },
    ),
    execInSandbox: vi.fn<WriteHandlerContext['execInSandbox']>(
      async () => opts.execResult ?? okExec(),
    ),
    versionCacheGet: vi.fn<WriteHandlerContext['versionCacheGet']>(() => undefined),
    versionCacheSet: vi.fn<WriteHandlerContext['versionCacheSet']>(),
    versionCacheDelete: vi.fn<WriteHandlerContext['versionCacheDelete']>(),
    versionCacheDeletePath: vi.fn<WriteHandlerContext['versionCacheDeletePath']>(),
    getWorkspaceRevisionByKey: vi.fn<WriteHandlerContext['getWorkspaceRevisionByKey']>(
      () => undefined,
    ),
    setSandboxWorkspaceRevision: vi.fn<WriteHandlerContext['setSandboxWorkspaceRevision']>(),
    setWorkspaceRevisionByKey: vi.fn<WriteHandlerContext['setWorkspaceRevisionByKey']>(),
    syncReadSnapshot: vi.fn<WriteHandlerContext['syncReadSnapshot']>(),
    invalidateWorkspaceSnapshots: vi.fn<WriteHandlerContext['invalidateWorkspaceSnapshots']>(
      () => 0,
    ),
    recordLedgerRead: vi.fn<WriteHandlerContext['recordLedgerRead']>(),
    recordLedgerAutoExpandAttempt: vi.fn<WriteHandlerContext['recordLedgerAutoExpandAttempt']>(),
    recordLedgerAutoExpandSuccess: vi.fn<WriteHandlerContext['recordLedgerAutoExpandSuccess']>(),
    recordLedgerSymbolAutoExpand: vi.fn<WriteHandlerContext['recordLedgerSymbolAutoExpand']>(),
    recordLedgerSymbolWarningSoftened:
      vi.fn<WriteHandlerContext['recordLedgerSymbolWarningSoftened']>(),
    recordLedgerCreation: vi.fn<WriteHandlerContext['recordLedgerCreation']>(),
    recordLedgerMutation: vi.fn<WriteHandlerContext['recordLedgerMutation']>(),
    markLedgerStale: vi.fn<WriteHandlerContext['markLedgerStale']>(),
    getLedgerStaleWarning: vi.fn<WriteHandlerContext['getLedgerStaleWarning']>(
      () => opts.staleWarning ?? null,
    ),
    getLedgerState: vi.fn<WriteHandlerContext['getLedgerState']>(() => opts.ledgerState),
    getLedgerProvenance: vi.fn<WriteHandlerContext['getLedgerProvenance']>(() => opts.provenance),
    restoreLedgerState: vi.fn<WriteHandlerContext['restoreLedgerState']>(),
    clearLedgerProvenance: vi.fn<WriteHandlerContext['clearLedgerProvenance']>(),
    checkWriteAllowed: vi.fn<WriteHandlerContext['checkWriteAllowed']>(
      () => opts.writeAllowedVerdict ?? allowVerdict,
    ),
    checkSymbolicEditAllowed: vi.fn<WriteHandlerContext['checkSymbolicEditAllowed']>(
      () => opts.symbolicVerdict ?? allowVerdict,
    ),
    checkLinesCovered: vi.fn<WriteHandlerContext['checkLinesCovered']>(() => allowVerdict),
    invalidateSymbolLedger: vi.fn<WriteHandlerContext['invalidateSymbolLedger']>(),
    recordWriteFileMetric: vi.fn<WriteHandlerContext['recordWriteFileMetric']>(),
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
