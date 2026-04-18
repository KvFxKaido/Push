/**
 * Sandbox read-only inspection tool handlers.
 *
 * Third extraction out of the `sandbox-tools.ts` dispatcher, after the
 * verification and git/release families. This module owns the five
 * read-only inspection tools:
 *
 *   - `sandbox_read_file`       → {@link handleReadFile}
 *   - `sandbox_search`          → {@link handleSearch}
 *   - `sandbox_list_dir`        → {@link handleListDir}
 *   - `sandbox_read_symbols`    → {@link handleReadSymbols}
 *   - `sandbox_find_references` → {@link handleFindReferences}
 *
 * These tools look read-only from the outside, but two of them write into
 * shared harness state that mutation tools depend on later:
 *
 *   - `sandbox_read_file` syncs file-version/workspace-revision snapshots,
 *     records file-awareness ledger coverage, and can invalidate workspace
 *     snapshots on `WORKSPACE_CHANGED`.
 *   - `sandbox_read_symbols` reads and writes the symbol persistence cache and
 *     records partial symbol coverage in the file-awareness ledger.
 *
 * The shared-state seams enter only through the handler context. Formatting,
 * redaction, path normalization, and other pure helpers stay as direct module
 * imports, matching the verification and git/release extraction pattern.
 */

import type { FileListCardData, ToolExecutionResult } from '@/types';
import type {
  ExecResult,
  FileEntry,
  FileReadResult,
  SandboxFindReferencesResult,
  SandboxReadSymbolsResult,
  SandboxSymbol,
} from './sandbox-client';
import type { SymbolKind, SymbolRead } from './file-awareness-ledger';
import type { SandboxToolCall } from './sandbox-tool-detection';

import { extractSignatures, extractSignaturesWithLines } from './file-awareness-ledger';
import { adaptiveHashDisplayLength, calculateLineHash } from './hashline';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';
import {
  buildSearchNoResultsHints,
  buildSearchPathErrorHints,
  classifyError,
  extractSandboxSearchResultPath,
  formatSandboxDisplayPath,
  formatSandboxDisplayScope,
  formatSandboxError,
  formatStructuredError,
  normalizeSandboxPath,
  shellEscape,
} from './sandbox-tool-utils';

type ReadFileArgs = Extract<SandboxToolCall, { tool: 'sandbox_read_file' }>['args'];
type SearchArgs = Extract<SandboxToolCall, { tool: 'sandbox_search' }>['args'];
type ListDirArgs = Extract<SandboxToolCall, { tool: 'sandbox_list_dir' }>['args'];
type ReadSymbolsArgs = Extract<SandboxToolCall, { tool: 'sandbox_read_symbols' }>['args'];
type FindReferencesArgs = Extract<SandboxToolCall, { tool: 'sandbox_find_references' }>['args'];

export interface ReadOnlyInspectionHandlerContext {
  sandboxId: string;
  readFromSandbox: (
    sandboxId: string,
    path: string,
    startLine?: number,
    endLine?: number,
  ) => Promise<FileReadResult>;
  execInSandbox: (
    sandboxId: string,
    command: string,
    workdir?: string,
    options?: { markWorkspaceMutated?: boolean },
  ) => Promise<ExecResult>;
  listDirectory: (sandboxId: string, path?: string) => Promise<FileEntry[]>;
  readSymbolsFromSandbox: (sandboxId: string, path: string) => Promise<SandboxReadSymbolsResult>;
  findReferencesInSandbox: (
    sandboxId: string,
    symbol: string,
    scope?: string,
    maxResults?: number,
  ) => Promise<SandboxFindReferencesResult>;
  syncReadSnapshot: (sandboxId: string, path: string, result: FileReadResult) => void;
  invalidateWorkspaceSnapshots: (
    sandboxId: string,
    currentWorkspaceRevision?: number | null,
  ) => number;
  deleteFileVersion: (sandboxId: string, path: string) => void;
  recordReadFileMetric: (event: {
    outcome: 'success' | 'error';
    payloadChars: number;
    isRangeRead: boolean;
    truncated?: boolean;
    emptyRange?: boolean;
    errorCode?: string;
  }) => void;
  recordLedgerRead: (
    path: string,
    opts?: {
      startLine?: number;
      endLine?: number;
      truncated?: boolean;
      totalLines?: number;
      symbols?: SymbolRead[];
    },
  ) => void;
  lookupCachedSymbols: (
    filePath: string,
  ) => { symbols: SandboxSymbol[]; totalLines: number } | undefined;
  storeCachedSymbols: (filePath: string, symbols: SandboxSymbol[], totalLines: number) => void;
}

const SANDBOX_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
  sh: 'shell',
  bash: 'shell',
  toml: 'toml',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
};

export async function handleReadFile(
  ctx: ReadOnlyInspectionHandlerContext,
  args: ReadFileArgs,
): Promise<ToolExecutionResult> {
  if (isSensitivePath(args.path)) {
    return { text: formatSensitivePathToolError(args.path) };
  }

  const isRangeRead = args.start_line !== undefined || args.end_line !== undefined;
  const result = (await ctx.readFromSandbox(
    ctx.sandboxId,
    args.path,
    args.start_line,
    args.end_line,
  )) as FileReadResult & { error?: string };

  if (result.error) {
    if (result.code === 'WORKSPACE_CHANGED') {
      ctx.invalidateWorkspaceSnapshots(ctx.sandboxId, result.current_workspace_revision);
    }
    ctx.deleteFileVersion(ctx.sandboxId, args.path);
    ctx.recordReadFileMetric({
      outcome: 'error',
      payloadChars: 0,
      isRangeRead,
      errorCode: 'READ_ERROR',
    });
    const err = classifyError(result.error, args.path);
    return {
      text: formatStructuredError(err, formatSandboxError(result.error, args.path)),
      structuredError: err,
    };
  }

  ctx.syncReadSnapshot(ctx.sandboxId, args.path, result);

  const rangeStart =
    typeof result.start_line === 'number' ? result.start_line : (args.start_line ?? 1);
  const rangeEnd = typeof result.end_line === 'number' ? result.end_line : args.end_line;

  let toolResultContent = '';
  const emptyRangeWarning = '';
  let visibleLineCount = 0;
  const safeContentResult = redactSensitiveText(result.content);
  const safeContent = safeContentResult.text;
  if (safeContent) {
    const contentLines = safeContent.split('\n');
    const hasTrailingNewline = safeContent.endsWith('\n') && contentLines.length > 1;
    const linesToNumber = hasTrailingNewline ? contentLines.slice(0, -1) : contentLines;
    visibleLineCount = linesToNumber.length;
    const maxLineNum = Math.max(rangeStart, rangeStart + linesToNumber.length - 1);
    const padWidth = String(maxLineNum).length;

    const fullHashes = await Promise.all(linesToNumber.map((line) => calculateLineHash(line, 12)));
    const hashDisplayLen = adaptiveHashDisplayLength(fullHashes);
    const lineHashes = fullHashes.map((hash) => hash.slice(0, hashDisplayLen));

    toolResultContent = linesToNumber
      .map(
        (line, idx) => `${String(rangeStart + idx).padStart(padWidth)}:${lineHashes[idx]}\t${line}`,
      )
      .join('\n');
  }

  const contentLineCount = visibleLineCount;
  const effectivelyFullRead = isRangeRead && !rangeEnd && !result.truncated;
  const readStartLine = isRangeRead && !effectivelyFullRead ? rangeStart : 1;
  const symbols = result.content ? extractSignaturesWithLines(result.content, readStartLine) : [];
  if (!emptyRangeWarning) {
    ctx.recordLedgerRead(args.path, {
      startLine: isRangeRead && !effectivelyFullRead ? rangeStart : undefined,
      endLine:
        isRangeRead && !effectivelyFullRead
          ? (rangeEnd ?? rangeStart + contentLineCount - 1)
          : undefined,
      truncated: Boolean(result.truncated),
      totalLines: contentLineCount,
      symbols,
    });
  }

  let signatureHint = '';
  if (result.truncated && result.content) {
    const signatures = extractSignatures(result.content);
    if (signatures) {
      signatureHint = `[Truncated content ${signatures}]`;
    }
  }

  const truncationLines = result.truncated
    ? [
        typeof result.truncated_at_line === 'number'
          ? `truncated_at_line: ${result.truncated_at_line}`
          : null,
        typeof result.remaining_bytes === 'number'
          ? `remaining_bytes: ${result.remaining_bytes}`
          : null,
      ].filter((line): line is string => Boolean(line))
    : [];

  const fileLabel = isRangeRead
    ? `Lines ${rangeStart}-${rangeEnd ?? '∞'} of ${args.path}`
    : `File: ${args.path}`;

  const lines: string[] = [
    `[Tool Result — sandbox_read_file]`,
    fileLabel,
    `Version: ${result.version || 'unknown'}`,
    result.truncated ? `(truncated)` : '',
    safeContentResult.redacted ? `Redactions: secret-like values hidden.` : '',
    ...truncationLines,
    signatureHint,
    emptyRangeWarning,
    toolResultContent,
  ].filter(Boolean);

  const emptyRange = isRangeRead && !result.content;
  ctx.recordReadFileMetric({
    outcome: 'success',
    payloadChars: result.content.length,
    isRangeRead,
    truncated: Boolean(result.truncated),
    emptyRange,
  });

  const ext = args.path.split('.').pop()?.toLowerCase() || '';
  const language = SANDBOX_LANGUAGE_BY_EXTENSION[ext] || ext;

  return {
    text: lines.join('\n'),
    card: {
      type: 'editor',
      data: {
        path: args.path,
        content: safeContent,
        language,
        truncated: result.truncated,
        version: typeof result.version === 'string' ? result.version : undefined,
        workspaceRevision:
          typeof result.workspace_revision === 'number' ? result.workspace_revision : undefined,
        source: 'sandbox' as const,
        sandboxId: ctx.sandboxId,
      },
    },
  };
}

export async function handleSearch(
  ctx: ReadOnlyInspectionHandlerContext,
  args: SearchArgs,
): Promise<ToolExecutionResult> {
  const query = args.query.trim();
  const searchPath = normalizeSandboxPath((args.path || '/workspace').trim() || '/workspace');

  if (!query) {
    return { text: '[Tool Error] sandbox_search requires a non-empty query.' };
  }
  if (isSensitivePath(searchPath)) {
    return { text: formatSensitivePathToolError(searchPath) };
  }

  const escapedQuery = shellEscape(query);
  const escapedPath = shellEscape(searchPath);
  const command = [
    'set -o pipefail;',
    'if command -v rg >/dev/null 2>&1; then',
    `  rg -n --hidden --glob '!.git' --color never -- ${escapedQuery} ${escapedPath} | head -n 121;`,
    'else',
    `  grep -RIn --exclude-dir=.git -- ${escapedQuery} ${escapedPath} | head -n 121;`,
    'fi',
  ].join(' ');

  const result = await ctx.execInSandbox(ctx.sandboxId, command);
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    if (result.exitCode === 1) {
      const hints = buildSearchNoResultsHints(query, searchPath);
      return {
        text: [
          `[Tool Result — sandbox_search]`,
          `No matches for "${query}" in ${searchPath}.`,
          '',
          'Suggestions:',
          ...hints.map((hint) => `- ${hint}`),
        ].join('\n'),
      };
    }

    const pathHint = buildSearchPathErrorHints(result.stderr || '', searchPath);
    if (pathHint) {
      return { text: pathHint };
    }
    return {
      text: formatSandboxError(result.stderr || 'Search failed', `sandbox_search (${searchPath})`),
    };
  }

  const output = result.stdout.trim();
  if (!output) {
    const hints = buildSearchNoResultsHints(query, searchPath);
    return {
      text: [
        `[Tool Result — sandbox_search]`,
        `No matches for "${query}" in ${searchPath}.`,
        '',
        'Suggestions:',
        ...hints.map((hint) => `- ${hint}`),
      ].join('\n'),
    };
  }

  const visibleLines: string[] = [];
  let hiddenMatches = 0;
  let redactedMatches = false;
  for (const rawLine of output.split('\n').slice(0, 120)) {
    const matchPath = extractSandboxSearchResultPath(rawLine);
    if (matchPath && isSensitivePath(matchPath)) {
      hiddenMatches += 1;
      continue;
    }
    const safeLine = redactSensitiveText(rawLine);
    redactedMatches ||= safeLine.redacted;
    visibleLines.push(
      safeLine.text.length > 320 ? `${safeLine.text.slice(0, 320)}...` : safeLine.text,
    );
  }

  if (visibleLines.length === 0 && hiddenMatches > 0) {
    return {
      text: [
        '[Tool Result — sandbox_search]',
        `Query: ${query}`,
        `Path: ${searchPath}`,
        'Matches were found only in protected secret files and were hidden.',
      ].join('\n'),
    };
  }

  const matchCount = visibleLines.length;
  const truncated = output.split('\n').length > visibleLines.length || result.truncated;

  return {
    text: [
      '[Tool Result — sandbox_search]',
      `Query: ${query}`,
      `Path: ${searchPath}`,
      `Matches: ${matchCount}${truncated ? ' (truncated)' : ''}`,
      hiddenMatches > 0
        ? `Hidden matches: ${hiddenMatches} secret-file result${hiddenMatches === 1 ? '' : 's'}`
        : '',
      redactedMatches ? 'Redactions: secret-like values hidden.' : '',
      '',
      ...visibleLines,
    ].join('\n'),
  };
}

export async function handleListDir(
  ctx: ReadOnlyInspectionHandlerContext,
  args: ListDirArgs,
): Promise<ToolExecutionResult> {
  const dirPath = normalizeSandboxPath(args.path || '/workspace');
  if (isSensitivePath(dirPath)) {
    return { text: formatSensitivePathToolError(dirPath) };
  }

  const entries = await ctx.listDirectory(ctx.sandboxId, dirPath);
  const filtered = filterSensitiveDirectoryEntries(dirPath, entries);

  const dirs = filtered.entries.filter((entry) => entry.type === 'directory');
  const files = filtered.entries.filter((entry) => entry.type === 'file');

  const lines: string[] = [
    `[Tool Result — sandbox_list_dir]`,
    `Directory: ${dirPath}`,
    `${dirs.length} directories, ${files.length} files\n`,
    filtered.hiddenCount > 0
      ? `(${filtered.hiddenCount} sensitive entr${filtered.hiddenCount === 1 ? 'y' : 'ies'} hidden)\n`
      : '',
  ];

  for (const dir of dirs) {
    lines.push(`  📁 ${dir.name}/`);
  }
  for (const file of files) {
    const size = file.size ? ` (${file.size} bytes)` : '';
    lines.push(`  📄 ${file.name}${size}`);
  }

  const cardData: FileListCardData = {
    path: dirPath,
    entries: [
      ...dirs.map((dir) => ({ name: dir.name, type: 'directory' as const })),
      ...files.map((file) => ({
        name: file.name,
        type: 'file' as const,
        size: file.size || undefined,
      })),
    ],
  };

  return { text: lines.join('\n'), card: { type: 'file-list', data: cardData } };
}

export async function handleReadSymbols(
  ctx: ReadOnlyInspectionHandlerContext,
  args: ReadSymbolsArgs,
): Promise<ToolExecutionResult> {
  const filePath = args.path;
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  try {
    const cached = ctx.lookupCachedSymbols(filePath);
    let symbols: SandboxSymbol[];
    let totalLines: number;

    if (cached) {
      symbols = cached.symbols;
      totalLines = cached.totalLines;
    } else {
      const result = await ctx.readSymbolsFromSandbox(ctx.sandboxId, filePath);
      symbols = result.symbols;
      totalLines = result.totalLines;
      ctx.storeCachedSymbols(filePath, result.symbols, totalLines);
    }

    const lang = ['py'].includes(ext)
      ? 'Python'
      : ['ts', 'tsx', 'js', 'jsx'].includes(ext)
        ? 'TypeScript/JavaScript'
        : ext;

    if (symbols.length > 0) {
      const validKinds = new Set<string>(['function', 'class', 'interface', 'export', 'type']);
      const ledgerSymbols: SymbolRead[] = symbols
        .filter((symbol) => validKinds.has(symbol.kind))
        .map((symbol) => {
          let normalizedKind = symbol.kind as SymbolKind;
          if (
            (normalizedKind === 'function' || normalizedKind === 'class') &&
            /^export\s+default\b/.test(symbol.signature)
          ) {
            normalizedKind = 'export';
          }
          return {
            name: symbol.name,
            kind: normalizedKind,
            lineRange: { start: symbol.line, end: symbol.line },
          };
        });
      if (ledgerSymbols.length > 0) {
        ctx.recordLedgerRead(filePath, {
          symbols: ledgerSymbols,
          totalLines,
          truncated: true,
        });
      }
    }

    const lines: string[] = [
      `[Tool Result — sandbox_read_symbols]`,
      `File: ${filePath} (${totalLines} lines, ${lang})`,
      `Symbols: ${symbols.length}`,
      '',
    ];

    for (const symbol of symbols) {
      lines.push(
        `  ${symbol.kind.padEnd(10)} L${String(symbol.line).padStart(4)}  ${symbol.signature}`,
      );
    }

    if (symbols.length === 0) {
      lines.push('  (no symbols found)');
    }

    return { text: lines.join('\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to extract symbols';
    const err = classifyError(message, filePath);
    return {
      text: formatStructuredError(err, `[Tool Error — sandbox_read_symbols]\n${message}`),
      structuredError: err,
    };
  }
}

export async function handleFindReferences(
  ctx: ReadOnlyInspectionHandlerContext,
  args: FindReferencesArgs,
): Promise<ToolExecutionResult> {
  const symbol = args.symbol;
  const scope = normalizeSandboxPath(args.scope || '/workspace');

  try {
    const { references, truncated } = await ctx.findReferencesInSandbox(
      ctx.sandboxId,
      symbol,
      scope,
      30,
    );
    const shownCount = references.length;
    const fileWidth = Math.max(
      ...references.map((reference) => formatSandboxDisplayPath(reference.file).length),
      0,
    );
    const lines: string[] = [
      `[Tool Result — sandbox_find_references]`,
      `Symbol: ${symbol}`,
      `Scope: ${formatSandboxDisplayScope(scope)}`,
      `References: ${shownCount}${truncated ? '+' : ''} (showing ${shownCount})`,
      '',
    ];

    if (references.length === 0) {
      lines.push('  (no references found)');
    } else {
      for (const reference of references) {
        lines.push(
          `  ${reference.kind.padEnd(6)}  L ${String(reference.line).padStart(3)}  ${formatSandboxDisplayPath(reference.file).padEnd(fileWidth)}  ${reference.context}`,
        );
      }
    }

    return { text: lines.join('\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to find references';
    const err = classifyError(message, symbol);
    return {
      text: formatStructuredError(err, `[Tool Error — sandbox_find_references]\n${message}`),
      structuredError: err,
    };
  }
}
