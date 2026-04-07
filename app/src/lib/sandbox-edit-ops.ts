/**
 * Edit-related operations extracted from sandbox-tools.ts.
 *
 * Covers prefetch cache, version sync, guard helpers, hashline ops,
 * chunked reading, and per-edit / patchset diagnostics.
 */

import {
  readFromSandbox,
  execInSandbox,
  type FileReadResult,
} from './sandbox-client';
import {
  fileVersionKey,
  getSandboxWorkspaceRevision,
  setByKey as versionCacheSet,
  setWorkspaceRevisionByKey,
  setSandboxWorkspaceRevision,
  deleteByKey as versionCacheDelete,
  clearFileVersionCache,
} from './sandbox-file-version-cache';
import { fileLedger } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { calculateLineHash, type HashlineOp } from './hashline';
import { normalizeSandboxPath, shellEscape } from './sandbox-tool-utils';

// ---------------------------------------------------------------------------
// Prefetch cache
// ---------------------------------------------------------------------------

export interface PrefetchedEditFileState {
  content: string;
  version?: string;
  workspaceRevision?: number;
  truncated: boolean;
  expiresAt: number;
}

const PREFETCHED_EDIT_FILE_TTL_MS = 30_000;
const prefetchedEditFiles = new Map<string, PrefetchedEditFileState>();

export function prefetchedEditFileKey(sandboxId: string, path: string): string {
  return `${sandboxId}:${normalizeSandboxPath(path)}`;
}

export function setPrefetchedEditFile(
  sandboxId: string,
  path: string,
  content: string,
  version?: string,
  workspaceRevision?: number,
  truncated: boolean = false,
): void {
  prefetchedEditFiles.set(prefetchedEditFileKey(sandboxId, path), {
    content,
    version,
    workspaceRevision,
    truncated,
    expiresAt: Date.now() + PREFETCHED_EDIT_FILE_TTL_MS,
  });
}

export function takePrefetchedEditFile(sandboxId: string, path: string): PrefetchedEditFileState | null {
  const key = prefetchedEditFileKey(sandboxId, path);
  const cached = prefetchedEditFiles.get(key);
  if (!cached) return null;
  prefetchedEditFiles.delete(key);
  if (cached.expiresAt < Date.now()) return null;
  const latestRevision = getSandboxWorkspaceRevision(sandboxId);
  if (
    typeof cached.workspaceRevision === 'number'
    && typeof latestRevision === 'number'
    && cached.workspaceRevision !== latestRevision
  ) {
    return null;
  }
  return cached;
}

export function clearPrefetchedEditFileCache(sandboxId?: string): void {
  if (!sandboxId) {
    prefetchedEditFiles.clear();
    return;
  }
  const prefix = `${sandboxId}:`;
  for (const key of [...prefetchedEditFiles.keys()]) {
    if (key.startsWith(prefix)) {
      prefetchedEditFiles.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Version sync
// ---------------------------------------------------------------------------

export function syncReadSnapshot(sandboxId: string, path: string, result: FileReadResult): void {
  const cacheKey = fileVersionKey(sandboxId, path);
  if (typeof result.workspace_revision === 'number') {
    setSandboxWorkspaceRevision(sandboxId, result.workspace_revision);
    setWorkspaceRevisionByKey(cacheKey, result.workspace_revision);
  }
  if (typeof result.version === 'string' && result.version) {
    versionCacheSet(cacheKey, result.version);
  } else if (!('error' in result)) {
    versionCacheDelete(cacheKey);
  }
}

export function invalidateWorkspaceSnapshots(sandboxId: string, currentWorkspaceRevision?: number | null): number {
  if (typeof currentWorkspaceRevision === 'number') {
    setSandboxWorkspaceRevision(sandboxId, currentWorkspaceRevision);
  }
  clearFileVersionCache(sandboxId);
  clearPrefetchedEditFileCache(sandboxId);
  symbolLedger.invalidateAll();
  return fileLedger.markAllStale();
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

export function isUnknownSymbolGuardReason(reason: string): boolean {
  return /^Read symbol '.+' before editing\./.test(reason.trim());
}

export const LINE_QUALIFIED_REF_RE = /^(\d+):([a-f0-9]{7,12})$/i;
export const PATCHSET_DETAIL_MAX_FAILURES = 12;
export const PATCHSET_DETAIL_MAX_CHARS = 1500;

export function parseLineQualifiedRef(ref: string): { lineNo: number; hashLength: number } | null {
  const m = ref.trim().match(LINE_QUALIFIED_REF_RE);
  if (!m) return null;
  return { lineNo: Number(m[1]), hashLength: m[2].length };
}

export function recordPatchsetStaleConflict(
  sandboxId: string,
  path: string,
  expectedVersion?: string | null,
  currentVersion?: string | null,
): string {
  const cacheKey = fileVersionKey(sandboxId, path);
  if (typeof currentVersion === 'string' && currentVersion) {
    versionCacheSet(cacheKey, currentVersion);
  } else {
    versionCacheDelete(cacheKey);
  }
  fileLedger.markStale(path);
  symbolLedger.invalidate(path);
  const expected = expectedVersion || 'unknown';
  const current = currentVersion || 'missing';
  return `${path}: stale write rejected (expected=${expected} current=${current})`;
}

export function buildPatchsetFailureDetail(writeFailures: string[]): string {
  const shown = writeFailures.slice(0, PATCHSET_DETAIL_MAX_FAILURES);
  let detail = shown.join('; ');
  if (writeFailures.length > PATCHSET_DETAIL_MAX_FAILURES) {
    detail += `; ... (+${writeFailures.length - PATCHSET_DETAIL_MAX_FAILURES} more)`;
  }
  if (detail.length > PATCHSET_DETAIL_MAX_CHARS) {
    detail = `${detail.slice(0, PATCHSET_DETAIL_MAX_CHARS)}...`;
  }
  return detail;
}

const BARE_HASH_REF_RE = /^([a-f0-9]{7,12})$/i;

function parseBareHashRef(ref: string): { hash: string; hashLength: number } | null {
  const match = ref.trim().match(BARE_HASH_REF_RE);
  if (!match) return null;
  return { hash: match[1].toLowerCase(), hashLength: match[1].length };
}

export async function buildHashlineRetryHints(
  content: string,
  edits: HashlineOp[],
  path: string,
): Promise<string[]> {
  const rawLines = content.split('\n');
  const visibleLines = content.endsWith('\n') ? rawLines.slice(0, -1) : rawLines;
  if (visibleLines.length === 0) return [];

  const fullHashes = await Promise.all(visibleLines.map((line) => calculateLineHash(line, 12)));
  const hints: string[] = [];

  for (const edit of edits) {
    const lineQualified = parseLineQualifiedRef(edit.ref);
    if (lineQualified) {
      const idx = lineQualified.lineNo - 1;
      if (idx < 0 || idx >= visibleLines.length) continue;
      const refreshedHash = fullHashes[idx].slice(0, lineQualified.hashLength);
      const refreshedRef = `${lineQualified.lineNo}:${refreshedHash}`;
      if (refreshedRef.toLowerCase() !== edit.ref.trim().toLowerCase()) {
        hints.push(`Same-line retry for "${edit.ref}": use "${refreshedRef}".`);
      }
      continue;
    }

    const bareHash = parseBareHashRef(edit.ref);
    if (!bareHash) continue;

    const matches = fullHashes
      .map((hash, index) => (hash.startsWith(bareHash.hash) ? index : -1))
      .filter((index) => index !== -1);
    if (matches.length <= 1) continue;

    const suggestedRefs = matches
      .slice(0, 4)
      .map((index) => `"${index + 1}:${fullHashes[index].slice(0, bareHash.hashLength)}"`)
      .join(', ');
    hints.push(`Disambiguate "${edit.ref}" with a line-qualified ref: ${suggestedRefs}${matches.length > 4 ? ', …' : ''}.`);
  }

  if (hints.length > 0) {
    hints.push(`If you're replacing a contiguous block in ${path}, prefer sandbox_edit_range with explicit start/end lines.`);
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Hashline ops
// ---------------------------------------------------------------------------

export async function buildRangeReplaceHashlineOps(
  content: string,
  startLine: number,
  endLine: number,
  replacementContent: string,
): Promise<{ ops: HashlineOp[]; visibleLineCount: number }> {
  const rawLines = content.split('\n');
  const visibleLines = content.endsWith('\n') ? rawLines.slice(0, -1) : rawLines;
  const visibleLineCount = visibleLines.length;

  if (visibleLineCount === 0) {
    throw new Error('File is empty. Use sandbox_write_file or sandbox_edit_file to add initial content.');
  }
  if (startLine < 1 || endLine < startLine || endLine > visibleLineCount) {
    throw new Error(
      `Invalid range ${startLine}-${endLine}. File has ${visibleLineCount} visible line(s).`,
    );
  }

  const refForVisibleLine = async (lineNo: number): Promise<string> => {
    const line = visibleLines[lineNo - 1];
    const hash = await calculateLineHash(line, 7);
    return `${lineNo}:${hash}`;
  };

  const replacementLines = replacementContent.length === 0 ? [] : replacementContent.split('\n');
  const ops: HashlineOp[] = [];

  // Pure deletion of range
  if (replacementLines.length === 0) {
    for (let lineNo = endLine; lineNo >= startLine; lineNo -= 1) {
      ops.push({ op: 'delete_line', ref: await refForVisibleLine(lineNo) });
    }
    return { ops, visibleLineCount };
  }

  // Remove old lines in descending order (except the anchor line), then replace anchor
  for (let lineNo = endLine; lineNo >= startLine + 1; lineNo -= 1) {
    ops.push({ op: 'delete_line', ref: await refForVisibleLine(lineNo) });
  }
  const anchorOldRef = await refForVisibleLine(startLine);
  ops.push({ op: 'replace_line', ref: anchorOldRef, content: replacementLines[0] });

  // Insert additional lines after the anchor.
  // Use the original anchor ref — applyHashlineEdits resolves all refs against the
  // original content upfront, so a ref based on the post-replace hash would fail.
  // Same-anchor insert_after ops are applied in declaration order
  // (applyHashlineEdits shifts indices for stacking), so no .reverse().
  if (replacementLines.length > 1) {
    for (const line of replacementLines.slice(1)) {
      ops.push({ op: 'insert_after', ref: anchorOldRef, content: line });
    }
  }

  return { ops, visibleLineCount };
}

// ---------------------------------------------------------------------------
// Chunked reading
// ---------------------------------------------------------------------------

export async function readFullFileByChunks(
  sandboxId: string,
  path: string,
  versionHint?: string | null,
): Promise<{ content: string; version?: string | null; workspaceRevision?: number | null; truncated: boolean }> {
  const chunkSize = 400;
  const maxChunks = 200;
  let version = versionHint;

  // Phase 1: Fetch the first chunk to establish version and determine if we
  // can use parallel fetching for the rest.
  const firstRange = await readFromSandbox(sandboxId, path, 1, chunkSize) as FileReadResult & { error?: string };
  if (firstRange.error) {
    if (firstRange.code === 'WORKSPACE_CHANGED') {
      invalidateWorkspaceSnapshots(sandboxId, firstRange.current_workspace_revision);
    }
    throw new Error(firstRange.error);
  }
  if (!version && typeof firstRange.version === 'string' && firstRange.version) {
    version = firstRange.version;
  }
  const workspaceRevision = typeof firstRange.workspace_revision === 'number'
    ? firstRange.workspace_revision
    : null;
  if (!firstRange.content) {
    return { content: '', version, workspaceRevision, truncated: false };
  }

  // If the first chunk was itself truncated by payload size, we can't parallelize safely.
  if (firstRange.truncated) {
    return { content: firstRange.content, version, workspaceRevision, truncated: true };
  }

  const firstLines = firstRange.content.split('\n');
  const firstHadTrailing = firstRange.content.endsWith('\n');
  const firstNormalized = firstHadTrailing ? firstLines.slice(0, -1) : firstLines;

  // If first chunk is not full, the file fits in one chunk — done.
  if (firstNormalized.length < chunkSize) {
    return { content: firstRange.content, version, workspaceRevision, truncated: false };
  }

  // Phase 2: Get total line count so we can issue parallel chunk requests.
  // Use `sed -n '$='` instead of `wc -l` — wc undercounts files missing a trailing newline.
  let totalLines = 0;
  try {
    const lineCountResult = await execInSandbox(sandboxId, `sed -n '$=' ${shellEscape(path)}`);
    if (lineCountResult.exitCode === 0 && lineCountResult.stdout.trim()) {
      totalLines = parseInt(lineCountResult.stdout.trim(), 10);
    }
  } catch { /* fall through to sequential */ }

  // Phase 3: If we have a line count, fetch remaining chunks in parallel.
  if (totalLines > chunkSize) {
    const collected: string[] = [...firstNormalized];
    let truncated = false;
    let lastHadTrailingNewline = firstHadTrailing;

    const remainingChunks: Array<{ start: number; end: number }> = [];
    for (let start = chunkSize + 1; start <= totalLines; start += chunkSize) {
      remainingChunks.push({ start, end: Math.min(start + chunkSize - 1, totalLines) });
      if (remainingChunks.length >= maxChunks - 1) break;
    }

    // Fetch remaining chunks in parallel with concurrency limit to avoid
    // overwhelming the sandbox with too many simultaneous requests.
    const MAX_CONCURRENT_CHUNKS = 8;
    const chunkResults: Array<FileReadResult & { error?: string }> = [];
    for (let i = 0; i < remainingChunks.length; i += MAX_CONCURRENT_CHUNKS) {
      const batch = remainingChunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
      const batchResults = await Promise.all(
        batch.map(({ start, end }) =>
          readFromSandbox(sandboxId, path, start, end) as Promise<FileReadResult & { error?: string }>
        )
      );
      chunkResults.push(...batchResults);
      // Stop early if any chunk in this batch was truncated or empty
      if (batchResults.some(r => r.truncated || !r.content)) break;
    }

    for (const range of chunkResults) {
      if (range.error) {
        if (range.code === 'WORKSPACE_CHANGED') {
          invalidateWorkspaceSnapshots(sandboxId, range.current_workspace_revision);
        }
        throw new Error(range.error);
      }
      if (
        typeof workspaceRevision === 'number'
        && typeof range.workspace_revision === 'number'
        && range.workspace_revision !== workspaceRevision
      ) {
        throw new Error('Workspace changed during read. Retry the read before editing.');
      }
      if (!range.content) break;

      if (range.truncated) {
        truncated = true;
      }

      const lines = range.content.split('\n');
      const hadTrailing = range.content.endsWith('\n');
      lastHadTrailingNewline = hadTrailing;
      const normalized = hadTrailing ? lines.slice(0, -1) : lines;
      collected.push(...normalized);

      if (range.truncated) break;
    }

    let content = collected.join('\n');
    if (lastHadTrailingNewline) {
      content += '\n';
    }
    return { content, version, workspaceRevision, truncated };
  }

  // Fallback: sequential reads (if wc -l failed or file is small)
  const collected: string[] = [...firstNormalized];
  let startLine = chunkSize + 1;
  let truncated = false;
  let lastHadTrailingNewline = firstHadTrailing;

  for (let i = 1; i < maxChunks; i += 1) {
    const range = await readFromSandbox(sandboxId, path, startLine, startLine + chunkSize - 1) as FileReadResult & { error?: string };
    if (range.error) {
      if (range.code === 'WORKSPACE_CHANGED') {
        invalidateWorkspaceSnapshots(sandboxId, range.current_workspace_revision);
      }
      throw new Error(range.error);
    }
    if (
      typeof workspaceRevision === 'number'
      && typeof range.workspace_revision === 'number'
      && range.workspace_revision !== workspaceRevision
    ) {
      throw new Error('Workspace changed during read. Retry the read before editing.');
    }
    if (!version && typeof range.version === 'string' && range.version) {
      version = range.version;
    }
    if (!range.content) {
      // Preserve lastHadTrailingNewline from the previous chunk — an empty
      // response means EOF, so the trailing-newline state of the last real
      // chunk is what matters.
      break;
    }

    if (range.truncated) {
      truncated = true;
    }

    const lines = range.content.split('\n');
    const hadTrailingNewline = range.content.endsWith('\n');
    lastHadTrailingNewline = hadTrailingNewline;
    const normalized = hadTrailingNewline ? lines.slice(0, -1) : lines;

    collected.push(...normalized);
    if (range.truncated) break;
    if (normalized.length < chunkSize) break;
    startLine += normalized.length;

    if (i === maxChunks - 1 && normalized.length === chunkSize) {
      truncated = true;
    }
  }

  let content = collected.join('\n');
  if (lastHadTrailingNewline) {
    content += '\n';
  }

  return {
    content,
    version,
    workspaceRevision,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Per-edit fast syntax check. Returns diagnostic text or null if clean/unsupported/timeout. */
export async function runPerEditDiagnostics(sandboxId: string, filePath: string): Promise<string | null> {
  const ext = filePath.split('.').pop()?.toLowerCase();
  let cmd: string;

  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    // transpileModule: fast single-file syntax check (~50ms), no project resolution.
    // Catches syntax errors and JSX issues, NOT type errors (that's Tier 2).
    // Uses single-quoted shell string to avoid $-interpolation; file path passed via env var.
    const escaped = shellEscape(filePath);
    cmd = `timeout 3 env __DIAG_FILE=${escaped} node -e 'try{var ts=require("typescript")}catch(e){process.exit(0)}var fs=require("fs");var f=process.env.__DIAG_FILE;var src=fs.readFileSync(f,"utf8");var r=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});if(r.diagnostics&&r.diagnostics.length>0){r.diagnostics.forEach(function(d){var m=ts.flattenDiagnosticMessageText(d.messageText,"\\n");var loc="";if(d.start!==undefined)loc=":"+(src.substring(0,d.start).split("\\n").length);console.error(f+loc+" - error: "+m)});process.exit(1)}' 2>&1`;
  } else if (ext === 'py') {
    cmd = `timeout 3 python3 -m py_compile ${shellEscape(filePath)} 2>&1`;
  } else {
    return null;
  }

  try {
    const result = await execInSandbox(sandboxId, cmd);
    if (result.exitCode === 124) return null; // timeout — silently skip
    if (result.exitCode !== 0) {
      const output = (result.stderr || result.stdout || '').trim();
      // Filter out harness/runtime noise (MODULE_NOT_FOUND, permission errors)
      if (output && !output.includes('MODULE_NOT_FOUND') && !output.includes('Cannot find module')) {
        return output.slice(0, 1500);
      }
    }
    return null; // clean
  } catch {
    return null; // exec error — silently skip
  }
}

/** Patchset-level full project typecheck. Returns diagnostic text filtered to changed files, or null. */
export async function runPatchsetDiagnostics(sandboxId: string, changedFiles: string[]): Promise<string | null> {
  if (changedFiles.length === 0) return null;

  // Only run if any changed files are TypeScript
  const hasTs = changedFiles.some(f => /\.(ts|tsx)$/.test(f));
  if (!hasTs) return null;

  try {
    const result = await execInSandbox(sandboxId, 'timeout 2 npx tsc --noEmit --pretty false 2>&1');
    if (result.exitCode === 124) return null; // timeout — silently skip
    if (result.exitCode === 0) return null; // clean

    const output = (result.stdout || result.stderr || '').trim();
    if (!output) return null;

    // Filter to only diagnostics referencing changed files
    const normalizedChanged = new Set(changedFiles.map(f =>
      f.replace(/^\/workspace\//, '').replace(/^\.\//, ''),
    ));
    const filtered = output.split('\n').filter(line => {
      // tsc output format: "src/lib/foo.ts(42,5): error TS1234: ..."
      for (const cf of normalizedChanged) {
        if (line.includes(cf)) return true;
      }
      return false;
    });

    if (filtered.length === 0) return null; // no diagnostics for changed files
    return filtered.slice(0, 20).join('\n').slice(0, 2000); // cap at 20 lines / 2k chars
  } catch {
    return null;
  }
}
