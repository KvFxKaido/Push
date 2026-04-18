import { describe, expect, it, vi } from 'vitest';
import {
  handleFindReferences,
  handleListDir,
  handleReadFile,
  handleReadSymbols,
  handleSearch,
  type ReadOnlyInspectionHandlerContext,
} from './sandbox-read-only-inspection-handlers';
import type {
  ExecResult,
  FileEntry,
  FileReadResult,
  SandboxFindReferencesResult,
  SandboxReadSymbolsResult,
  SandboxSymbol,
} from './sandbox-client';

const okExec = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

interface MockedContext extends ReadOnlyInspectionHandlerContext {
  readFromSandbox: ReturnType<typeof vi.fn<ReadOnlyInspectionHandlerContext['readFromSandbox']>>;
  execInSandbox: ReturnType<typeof vi.fn<ReadOnlyInspectionHandlerContext['execInSandbox']>>;
  listDirectory: ReturnType<typeof vi.fn<ReadOnlyInspectionHandlerContext['listDirectory']>>;
  readSymbolsFromSandbox: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['readSymbolsFromSandbox']>
  >;
  findReferencesInSandbox: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['findReferencesInSandbox']>
  >;
  syncReadSnapshot: ReturnType<typeof vi.fn<ReadOnlyInspectionHandlerContext['syncReadSnapshot']>>;
  invalidateWorkspaceSnapshots: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['invalidateWorkspaceSnapshots']>
  >;
  deleteFileVersion: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['deleteFileVersion']>
  >;
  recordReadFileMetric: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['recordReadFileMetric']>
  >;
  recordLedgerRead: ReturnType<typeof vi.fn<ReadOnlyInspectionHandlerContext['recordLedgerRead']>>;
  lookupCachedSymbols: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['lookupCachedSymbols']>
  >;
  storeCachedSymbols: ReturnType<
    typeof vi.fn<ReadOnlyInspectionHandlerContext['storeCachedSymbols']>
  >;
}

interface MakeContextOpts {
  readResult?: FileReadResult;
  execResult?: ExecResult;
  entries?: FileEntry[];
  symbolResult?: SandboxReadSymbolsResult;
  referencesResult?: SandboxFindReferencesResult;
  cachedSymbols?: { symbols: SandboxSymbol[]; totalLines: number };
}

function makeContext(opts: MakeContextOpts = {}): MockedContext {
  return {
    sandboxId: 'sb-1',
    readFromSandbox: vi.fn<ReadOnlyInspectionHandlerContext['readFromSandbox']>(
      async () => opts.readResult ?? { content: '', truncated: false },
    ),
    execInSandbox: vi.fn<ReadOnlyInspectionHandlerContext['execInSandbox']>(
      async () => opts.execResult ?? okExec(),
    ),
    listDirectory: vi.fn<ReadOnlyInspectionHandlerContext['listDirectory']>(
      async () => opts.entries ?? [],
    ),
    readSymbolsFromSandbox: vi.fn<ReadOnlyInspectionHandlerContext['readSymbolsFromSandbox']>(
      async () => opts.symbolResult ?? { symbols: [], totalLines: 0 },
    ),
    findReferencesInSandbox: vi.fn<ReadOnlyInspectionHandlerContext['findReferencesInSandbox']>(
      async () => opts.referencesResult ?? { references: [], truncated: false },
    ),
    syncReadSnapshot: vi.fn<ReadOnlyInspectionHandlerContext['syncReadSnapshot']>(),
    invalidateWorkspaceSnapshots: vi.fn<
      ReadOnlyInspectionHandlerContext['invalidateWorkspaceSnapshots']
    >(() => 0),
    deleteFileVersion: vi.fn<ReadOnlyInspectionHandlerContext['deleteFileVersion']>(),
    recordReadFileMetric: vi.fn<ReadOnlyInspectionHandlerContext['recordReadFileMetric']>(),
    recordLedgerRead: vi.fn<ReadOnlyInspectionHandlerContext['recordLedgerRead']>(),
    lookupCachedSymbols: vi.fn<ReadOnlyInspectionHandlerContext['lookupCachedSymbols']>(
      () => opts.cachedSymbols,
    ),
    storeCachedSymbols: vi.fn<ReadOnlyInspectionHandlerContext['storeCachedSymbols']>(),
  };
}

describe('handleReadFile', () => {
  it('formats numbered content, records ledger coverage, and returns an editor card', async () => {
    const readResult: FileReadResult = {
      content: 'export const x = 1;\nconst y = 2;\n',
      version: 'abc123',
      truncated: false,
    };
    const ctx = makeContext({ readResult });

    const result = await handleReadFile(ctx, { path: '/workspace/src/app.ts' });

    expect(ctx.readFromSandbox).toHaveBeenCalledWith(
      'sb-1',
      '/workspace/src/app.ts',
      undefined,
      undefined,
    );
    expect(ctx.syncReadSnapshot).toHaveBeenCalledWith('sb-1', '/workspace/src/app.ts', readResult);
    expect(ctx.recordLedgerRead).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      expect.objectContaining({ totalLines: 2, truncated: false }),
    );
    expect(ctx.recordReadFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', isRangeRead: false, emptyRange: false }),
    );
    expect(result.text).toContain('[Tool Result — sandbox_read_file]');
    expect(result.text).toMatch(/1:[^\t]+\texport const x = 1;/);
    expect(result.text).toMatch(/2:[^\t]+\tconst y = 2;/);
    expect(result.card?.type).toBe('editor');
    if (result.card?.type === 'editor') {
      expect(result.card.data.path).toBe('/workspace/src/app.ts');
      expect(result.card.data.language).toBe('typescript');
      expect(result.card.data.version).toBe('abc123');
    }
  });

  it('invalidates snapshots and clears the file version on workspace-changed reads', async () => {
    const ctx = makeContext({
      readResult: {
        content: '',
        truncated: false,
        error: 'workspace_changed: file changed underfoot',
        code: 'WORKSPACE_CHANGED',
        current_workspace_revision: 7,
      } as FileReadResult,
    });

    const result = await handleReadFile(ctx, {
      path: '/workspace/src/app.ts',
      start_line: 3,
    });

    expect(ctx.invalidateWorkspaceSnapshots).toHaveBeenCalledWith('sb-1', 7);
    expect(ctx.deleteFileVersion).toHaveBeenCalledWith('sb-1', '/workspace/src/app.ts');
    expect(ctx.recordReadFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', isRangeRead: true, errorCode: 'READ_ERROR' }),
    );
    expect(result.structuredError?.type).toBe('WORKSPACE_CHANGED');
  });
});

describe('handleSearch', () => {
  it('reports visible matches, hidden secret-file matches, and redactions', async () => {
    const ctx = makeContext({
      execResult: okExec(
        '/workspace/secrets/id_rsa:1:ssh-rsa AAA\n/workspace/src/config.ts:5:API_KEY=sk-1234567890abcdef12345\n',
      ),
    });

    const result = await handleSearch(ctx, { query: 'API_KEY' });

    expect(ctx.execInSandbox).toHaveBeenCalledWith(
      'sb-1',
      expect.stringContaining(
        "rg -n --hidden --glob '!.git' --color never -- 'API_KEY' '/workspace'",
      ),
    );
    expect(result.text).toContain('Matches: 1 (truncated)');
    expect(result.text).toContain('Hidden matches: 1 secret-file result');
    expect(result.text).toContain('Redactions: secret-like values hidden.');
    expect(result.text).not.toContain('id_rsa');
    expect(result.text).toContain('API_KEY=[REDACTED');
  });
});

describe('handleListDir', () => {
  it('filters sensitive entries and returns a file-list card', async () => {
    const ctx = makeContext({
      entries: [
        { name: 'src', path: '/workspace/src', type: 'directory', size: 0 },
        { name: 'app.ts', path: '/workspace/app.ts', type: 'file', size: 1234 },
        { name: '.env', path: '/workspace/.env', type: 'file', size: 16 },
      ],
    });

    const result = await handleListDir(ctx, { path: '/workspace' });

    expect(ctx.listDirectory).toHaveBeenCalledWith('sb-1', '/workspace');
    expect(result.text).toContain('(1 sensitive entry hidden)');
    expect(result.text).toContain('📁 src/');
    expect(result.text).toContain('📄 app.ts (1234 bytes)');
    expect(result.text).not.toContain('.env');
    expect(result.card?.type).toBe('file-list');
    if (result.card?.type === 'file-list') {
      expect(result.card.data.path).toBe('/workspace');
      expect(result.card.data.entries).toEqual([
        { name: 'src', type: 'directory' },
        { name: 'app.ts', type: 'file', size: 1234 },
      ]);
    }
  });
});

describe('handleReadSymbols', () => {
  it('uses cached symbols without hitting the sandbox and records partial coverage', async () => {
    const ctx = makeContext({
      cachedSymbols: {
        symbols: [{ name: 'foo', kind: 'function', line: 10, signature: 'export function foo()' }],
        totalLines: 50,
      },
    });

    const result = await handleReadSymbols(ctx, { path: '/workspace/src/app.ts' });

    expect(ctx.lookupCachedSymbols).toHaveBeenCalledWith('/workspace/src/app.ts');
    expect(ctx.readSymbolsFromSandbox).not.toHaveBeenCalled();
    expect(ctx.recordLedgerRead).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      expect.objectContaining({ totalLines: 50, truncated: true }),
    );
    expect(result.text).toContain('File: /workspace/src/app.ts (50 lines, TypeScript/JavaScript)');
    expect(result.text).toMatch(/function\s+L\s+10\s+export function foo\(\)/);
  });

  it('stores sandbox symbols on a cache miss', async () => {
    const ctx = makeContext({
      symbolResult: {
        symbols: [{ name: 'Foo', kind: 'class', line: 15, signature: 'export class Foo' }],
        totalLines: 100,
      },
    });

    await handleReadSymbols(ctx, { path: '/workspace/src/app.ts' });

    expect(ctx.readSymbolsFromSandbox).toHaveBeenCalledWith('sb-1', '/workspace/src/app.ts');
    expect(ctx.storeCachedSymbols).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      [{ name: 'Foo', kind: 'class', line: 15, signature: 'export class Foo' }],
      100,
    );
  });
});

describe('handleFindReferences', () => {
  it('formats references with display paths and scope', async () => {
    const ctx = makeContext({
      referencesResult: {
        references: [
          {
            file: '/workspace/app/src/lib/utils.ts',
            line: 42,
            kind: 'call',
            context: 'result = computeHash(content)',
          },
          {
            file: '/workspace/app/src/lib/sandbox-tools.ts',
            line: 123,
            kind: 'import',
            context: 'import { computeHash } from "./hash"',
          },
        ],
        truncated: false,
      },
    });

    const result = await handleFindReferences(ctx, {
      symbol: 'computeHash',
      scope: 'app/src/lib',
    });

    expect(ctx.findReferencesInSandbox).toHaveBeenCalledWith(
      'sb-1',
      'computeHash',
      '/workspace/app/src/lib',
      30,
    );
    expect(result.text).toContain('Scope: app/src/lib/');
    expect(result.text).toMatch(/call\s+L\s+42\s+app\/src\/lib\/utils\.ts/);
    expect(result.text).toMatch(/import\s+L\s+123\s+app\/src\/lib\/sandbox-tools\.ts/);
  });
});
