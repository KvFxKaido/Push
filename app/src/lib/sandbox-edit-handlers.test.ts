import { describe, expect, it, vi } from 'vitest';
import {
  handleEditFile,
  handleEditRange,
  handleSearchReplace,
  type EditHandlerContext,
} from './sandbox-edit-handlers';
import type { ExecResult, FileReadResult, WriteResult } from './sandbox-client';
import type { EditGuardVerdict } from './file-awareness-ledger';

const okExec = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

const allowVerdict: EditGuardVerdict = { allowed: true };

interface MockedContext extends EditHandlerContext {
  readFromSandbox: ReturnType<typeof vi.fn<EditHandlerContext['readFromSandbox']>>;
  writeToSandbox: ReturnType<typeof vi.fn<EditHandlerContext['writeToSandbox']>>;
  execInSandbox: ReturnType<typeof vi.fn<EditHandlerContext['execInSandbox']>>;
  versionCacheSet: ReturnType<typeof vi.fn<EditHandlerContext['versionCacheSet']>>;
  versionCacheDelete: ReturnType<typeof vi.fn<EditHandlerContext['versionCacheDelete']>>;
  getWorkspaceRevisionByKey: ReturnType<
    typeof vi.fn<EditHandlerContext['getWorkspaceRevisionByKey']>
  >;
  setSandboxWorkspaceRevision: ReturnType<
    typeof vi.fn<EditHandlerContext['setSandboxWorkspaceRevision']>
  >;
  setWorkspaceRevisionByKey: ReturnType<
    typeof vi.fn<EditHandlerContext['setWorkspaceRevisionByKey']>
  >;
  syncReadSnapshot: ReturnType<typeof vi.fn<EditHandlerContext['syncReadSnapshot']>>;
  invalidateWorkspaceSnapshots: ReturnType<
    typeof vi.fn<EditHandlerContext['invalidateWorkspaceSnapshots']>
  >;
  takePrefetchedEditFile: ReturnType<typeof vi.fn<EditHandlerContext['takePrefetchedEditFile']>>;
  setPrefetchedEditFile: ReturnType<typeof vi.fn<EditHandlerContext['setPrefetchedEditFile']>>;
  recordLedgerRead: ReturnType<typeof vi.fn<EditHandlerContext['recordLedgerRead']>>;
  recordLedgerAutoExpandAttempt: ReturnType<
    typeof vi.fn<EditHandlerContext['recordLedgerAutoExpandAttempt']>
  >;
  recordLedgerAutoExpandSuccess: ReturnType<
    typeof vi.fn<EditHandlerContext['recordLedgerAutoExpandSuccess']>
  >;
  recordLedgerSymbolAutoExpand: ReturnType<
    typeof vi.fn<EditHandlerContext['recordLedgerSymbolAutoExpand']>
  >;
  recordLedgerSymbolWarningSoftened: ReturnType<
    typeof vi.fn<EditHandlerContext['recordLedgerSymbolWarningSoftened']>
  >;
  recordLedgerCreation: ReturnType<typeof vi.fn<EditHandlerContext['recordLedgerCreation']>>;
  recordLedgerMutation: ReturnType<typeof vi.fn<EditHandlerContext['recordLedgerMutation']>>;
  markLedgerStale: ReturnType<typeof vi.fn<EditHandlerContext['markLedgerStale']>>;
  checkSymbolicEditAllowed: ReturnType<
    typeof vi.fn<EditHandlerContext['checkSymbolicEditAllowed']>
  >;
  checkLinesCovered: ReturnType<typeof vi.fn<EditHandlerContext['checkLinesCovered']>>;
  invalidateSymbolLedger: ReturnType<typeof vi.fn<EditHandlerContext['invalidateSymbolLedger']>>;
}

interface MakeContextOpts {
  readResults?: FileReadResult[];
  writeResult?: WriteResult;
  execResult?: ExecResult;
  symbolicVerdict?: EditGuardVerdict;
  coverageVerdict?: EditGuardVerdict;
}

function makeContext(opts: MakeContextOpts = {}): MockedContext {
  const reads = opts.readResults ?? [{ content: '', truncated: false }];
  let readIdx = 0;
  return {
    sandboxId: 'sb-1',
    readFromSandbox: vi.fn<EditHandlerContext['readFromSandbox']>(
      async () => reads[Math.min(readIdx++, reads.length - 1)],
    ),
    writeToSandbox: vi.fn<EditHandlerContext['writeToSandbox']>(
      async (): Promise<WriteResult> =>
        opts.writeResult ?? { ok: true, new_version: 'v2', bytes_written: 10 },
    ),
    execInSandbox: vi.fn<EditHandlerContext['execInSandbox']>(
      async () => opts.execResult ?? okExec(),
    ),
    versionCacheSet: vi.fn<EditHandlerContext['versionCacheSet']>(),
    versionCacheDelete: vi.fn<EditHandlerContext['versionCacheDelete']>(),
    getWorkspaceRevisionByKey: vi.fn<EditHandlerContext['getWorkspaceRevisionByKey']>(
      () => undefined,
    ),
    setSandboxWorkspaceRevision: vi.fn<EditHandlerContext['setSandboxWorkspaceRevision']>(),
    setWorkspaceRevisionByKey: vi.fn<EditHandlerContext['setWorkspaceRevisionByKey']>(),
    syncReadSnapshot: vi.fn<EditHandlerContext['syncReadSnapshot']>(),
    invalidateWorkspaceSnapshots: vi.fn<EditHandlerContext['invalidateWorkspaceSnapshots']>(
      () => 0,
    ),
    takePrefetchedEditFile: vi.fn<EditHandlerContext['takePrefetchedEditFile']>(() => null),
    setPrefetchedEditFile: vi.fn<EditHandlerContext['setPrefetchedEditFile']>(),
    recordLedgerRead: vi.fn<EditHandlerContext['recordLedgerRead']>(),
    recordLedgerAutoExpandAttempt: vi.fn<EditHandlerContext['recordLedgerAutoExpandAttempt']>(),
    recordLedgerAutoExpandSuccess: vi.fn<EditHandlerContext['recordLedgerAutoExpandSuccess']>(),
    recordLedgerSymbolAutoExpand: vi.fn<EditHandlerContext['recordLedgerSymbolAutoExpand']>(),
    recordLedgerSymbolWarningSoftened:
      vi.fn<EditHandlerContext['recordLedgerSymbolWarningSoftened']>(),
    recordLedgerCreation: vi.fn<EditHandlerContext['recordLedgerCreation']>(),
    recordLedgerMutation: vi.fn<EditHandlerContext['recordLedgerMutation']>(),
    markLedgerStale: vi.fn<EditHandlerContext['markLedgerStale']>(),
    checkSymbolicEditAllowed: vi.fn<EditHandlerContext['checkSymbolicEditAllowed']>(
      () => opts.symbolicVerdict ?? allowVerdict,
    ),
    checkLinesCovered: vi.fn<EditHandlerContext['checkLinesCovered']>(
      () => opts.coverageVerdict ?? allowVerdict,
    ),
    invalidateSymbolLedger: vi.fn<EditHandlerContext['invalidateSymbolLedger']>(),
  };
}

describe('handleEditFile', () => {
  it('blocks when the symbolic guard denies and auto-read fails', async () => {
    const ctx = makeContext({
      symbolicVerdict: {
        allowed: false,
        code: 'UNREAD_SYMBOL',
        reason: 'Unread file /workspace/src/app.ts',
      },
      readResults: [{ content: '', truncated: false, error: 'ENOENT' } as FileReadResult],
    });

    const result = await handleEditFile(ctx, {
      path: '/workspace/src/app.ts',
      edits: [{ op: 'replace_line', ref: '1:abc1234', content: 'new' }],
    });

    expect(ctx.recordLedgerAutoExpandAttempt).toHaveBeenCalled();
    expect(ctx.writeToSandbox).not.toHaveBeenCalled();
    expect(result.structuredError?.type).toBe('EDIT_GUARD_BLOCKED');
    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
  });

  it('writes through the context, records mutation, and invalidates symbol ledger on success', async () => {
    const ctx = makeContext({
      readResults: [
        {
          content: 'const x = 1;\n',
          version: 'v1',
          truncated: false,
        } as FileReadResult,
        // Post-write verify read.
        { content: 'const x = 2;\n', version: 'v2', truncated: false } as FileReadResult,
      ],
      writeResult: { ok: true, new_version: 'v2', bytes_written: 14 },
    });

    // Hash by line-number ref so applyHashlineEdits can resolve it against the
    // fresh read above (any 7+ hex chars work — the hashline resolver accepts
    // partial matches when the line number uniquely identifies the target).
    const result = await handleEditFile(ctx, {
      path: '/workspace/src/app.ts',
      edits: [{ op: 'replace_line', ref: '1:abc1234', content: 'const x = 2;' }],
    });

    expect(ctx.writeToSandbox).toHaveBeenCalled();
    expect(ctx.recordLedgerCreation).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.recordLedgerMutation).toHaveBeenCalledWith('/workspace/src/app.ts', 'agent');
    expect(ctx.invalidateSymbolLedger).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(result.text).toContain('[Tool Result — sandbox_edit_file]');
    expect(result.postconditions?.touchedFiles[0]?.mutation).toBe('edit');
  });
});

describe('handleEditRange', () => {
  it('delegates to handleEditFile after priming the prefetch cache', async () => {
    const ctx = makeContext({
      readResults: [
        {
          content: 'line1\nline2\nline3\n',
          version: 'v1',
          truncated: false,
        } as FileReadResult,
        {
          content: 'line1\nREPLACED\nline3\n',
          version: 'v2',
          truncated: false,
        } as FileReadResult,
        // Post-write verify read.
        { content: 'line1', version: 'v2', truncated: false } as FileReadResult,
      ],
      writeResult: { ok: true, new_version: 'v2', bytes_written: 20 },
    });

    const result = await handleEditRange(ctx, {
      path: '/workspace/src/app.ts',
      start_line: 2,
      end_line: 2,
      content: 'REPLACED',
    });

    expect(ctx.setPrefetchedEditFile).toHaveBeenCalled();
    // handleEditFile takes over from here; it should consume the prefetch and succeed.
    expect(ctx.takePrefetchedEditFile).toHaveBeenCalled();
    expect(ctx.writeToSandbox).toHaveBeenCalled();
    expect(result.text).toContain('[Tool Result — sandbox_edit_file]');
  });
});

describe('handleSearchReplace', () => {
  it('returns EDIT_CONTENT_NOT_FOUND when the search string is missing', async () => {
    const ctx = makeContext({
      readResults: [
        {
          content: 'const a = 1;\nconst b = 2;\n',
          version: 'v1',
          truncated: false,
        } as FileReadResult,
      ],
    });

    const result = await handleSearchReplace(ctx, {
      path: '/workspace/src/app.ts',
      search: 'nonexistent',
      replace: 'replaced',
    });

    expect(result.structuredError?.type).toBe('EDIT_CONTENT_NOT_FOUND');
    expect(result.text).toContain('Search string not found');
  });

  it('flags ambiguous matches with EDIT_HASH_MISMATCH', async () => {
    const ctx = makeContext({
      readResults: [
        {
          content: 'foo = 1\nfoo = 2\nfoo = 3\n',
          version: 'v1',
          truncated: false,
        } as FileReadResult,
      ],
    });

    const result = await handleSearchReplace(ctx, {
      path: '/workspace/src/app.ts',
      search: 'foo',
      replace: 'bar',
    });

    expect(result.structuredError?.type).toBe('EDIT_HASH_MISMATCH');
    expect(result.text).toContain('Ambiguous');
  });
});
