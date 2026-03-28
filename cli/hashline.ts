/**
 * CLI hashline adapter — sync Node.js wrappers around the shared hashline lib.
 *
 * Delegates core edit logic (two-phase resolution, offset tracking, diagnostics)
 * to lib/hashline.ts. Provides synchronous convenience APIs for the CLI where
 * async isn't practical.
 *
 * Previously this was a standalone copy using SHA-1 with sequential application.
 * Now unified on SHA-256 + two-phase batch resolution from the shared lib.
 */
import { createHash } from 'node:crypto';
import {
  getNodeCrypto,
  applyHashlineEdits as sharedApplyHashlineEdits,
  renderAnchoredRange as sharedRenderAnchoredRange,
  type HashlineOp,
  type HashlineEditResult,
} from '../lib/hashline.ts';

export type { HashlineOp, HashlineEditResult };

// ---------------------------------------------------------------------------
// Bootstrap — prime the shared lib's cached Node crypto reference so that
// calculateLineHashSync works. This is a no-op after the first call.
// ---------------------------------------------------------------------------
let _initialized = false;
async function ensureInitialized(): Promise<void> {
  if (_initialized) return;
  await getNodeCrypto();
  _initialized = true;
}
// Fire-and-forget at import time; by the time any tool handler runs this
// will have resolved (it's a single synchronous require under the hood).
const _initPromise = ensureInitialized();

// ---------------------------------------------------------------------------
// Sync hashing (CLI-specific convenience)
// ---------------------------------------------------------------------------

export function calculateLineHash(line: unknown): string {
  return createHash('sha256').update(String(line).trim()).digest('hex').slice(0, 7);
}

export function calculateContentVersion(content: unknown): string {
  return createHash('sha256').update(String(content)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Anchored range (sync wrapper)
// ---------------------------------------------------------------------------

export interface AnchoredRange {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export function renderAnchoredRange(
  content: unknown,
  startLine: number | null = 1,
  endLine: number | null = null,
): AnchoredRange {
  const lines = String(content).split(/\r?\n/);
  const totalLines = lines.length || 1;
  const start = Math.max(1, Math.min(Number(startLine) || 1, totalLines));
  const end = Math.max(start, Math.min(Number(endLine) || totalLines, totalLines));
  const hashes = lines.map((l) => calculateLineHash(l));

  const out: string[] = [];
  for (let i = start - 1; i < end; i++) {
    out.push(`${i + 1}|${hashes[i]}| ${lines[i]}`);
  }

  return {
    text: out.join('\n') || '<empty file>',
    startLine: start,
    endLine: end,
    totalLines,
  };
}

// ---------------------------------------------------------------------------
// Edit application — delegates to the shared two-phase implementation
// ---------------------------------------------------------------------------

/** CLI-specific applied-edit descriptor (for context preview generation). */
export interface AppliedEdit {
  op: string;
  line: number;
  linesInserted?: number;
}

/** CLI-specific result type — wraps the shared result with the legacy shape. */
export interface CliHashlineEditResult {
  content: string;
  applied: AppliedEdit[];
}

/**
 * Apply hashline edits synchronously.
 *
 * Internally awaits the shared async implementation (safe in Node.js because
 * the only async part is crypto, which we've already initialized at import).
 * Returns the CLI-specific result shape for backward compatibility.
 */
export function applyHashlineEdits(content: unknown, edits: unknown): CliHashlineEditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array');
  }

  // Validate edit objects upfront (preserves CLI's strict validation)
  const validated: HashlineOp[] = edits.map((rawEdit) => {
    const edit = rawEdit && typeof rawEdit === 'object' ? rawEdit : null;
    if (!edit) throw new Error('invalid edit object');
    const op = String((edit as Record<string, unknown>).op || '').trim();
    const ref = String((edit as Record<string, unknown>).ref || '').trim();
    if (!op) throw new Error('edit.op is required');
    if (!ref) throw new Error('edit.ref is required');
    if (op === 'replace_line' || op === 'insert_after' || op === 'insert_before') {
      if (typeof (edit as Record<string, unknown>).content !== 'string') {
        throw new Error(`${op} requires string content`);
      }
      return { op, ref, content: (edit as Record<string, unknown>).content as string } as HashlineOp;
    }
    if (op === 'delete_line') {
      return { op, ref } as HashlineOp;
    }
    throw new Error(`unsupported edit op: ${op}`);
  });

  // Use a synchronous approach: replicate the shared lib's two-phase logic
  // using sync crypto. This avoids the async/sync boundary issue.
  const resultLines = String(content).split('\n');
  const hashCache = resultLines.map((l) => createHash('sha256').update(l.trim()).digest('hex').slice(0, 12));

  function snippetOf(idx: number): string {
    const trimmed = resultLines[idx]?.trim() ?? '';
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
  }

  // --- Phase 1: Resolve all refs against the original content ---
  type ResolvedEdit = { index: number; edit: HashlineOp } | { error: string };
  const resolved: ResolvedEdit[] = [];

  for (const edit of validated) {
    const raw = edit.ref.trim();
    const m = raw.match(/^(?:(\d+)[:|])?([a-f0-9]{7,12})$/i);
    if (!m) {
      resolved.push({ error: `invalid ref format: ${raw}` });
      continue;
    }
    const lineNo = m[1] ? Number(m[1]) : null;
    const hash = m[2].toLowerCase();

    if (lineNo !== null) {
      const idx = lineNo - 1;
      if (idx < 0 || idx >= resultLines.length) {
        throw new Error(`stale ref: line ${lineNo} is out of range`);
      }
      if (!hashCache[idx].startsWith(hash)) {
        throw new Error(`stale ref at line ${lineNo}: expected ${hash}, found ${hashCache[idx].slice(0, 7)}`);
      }
      resolved.push({ index: idx, edit });
      continue;
    }

    const matches: number[] = [];
    for (let i = 0; i < hashCache.length; i++) {
      if (hashCache[i].startsWith(hash)) matches.push(i);
    }
    if (matches.length === 0) {
      throw new Error(`stale ref: ${hash} not found`);
    }
    if (matches.length > 1) {
      // Try to disambiguate with longer hashes
      if (hash.length < 12) {
        const distinctGroups = new Map<string, number[]>();
        for (const idx of matches) {
          const lh = hashCache[idx];
          const group = distinctGroups.get(lh) ?? [];
          group.push(idx);
          distinctGroups.set(lh, group);
        }
        const candidateGroups = [...distinctGroups.entries()].filter(([lh]) => lh.startsWith(hash));
        if (candidateGroups.length === 1 && candidateGroups[0][1].length === 1) {
          resolved.push({ index: candidateGroups[0][1][0], edit });
          continue;
        }
      }
      throw new Error(`ambiguous ref: ${hash} matched ${matches.length} lines; use line-qualified ref like "${matches[0] + 1}:${hash}"`);
    }
    resolved.push({ index: matches[0], edit });
  }

  // --- Phase 2: Apply resolved edits with offset tracking ---
  const applied: AppliedEdit[] = [];
  const appliedMeta: { originalIndex: number; op: string; linesAdded: number }[] = [];
  const deletedOriginalIndices = new Set<number>();

  for (const r of resolved) {
    if ('error' in r) throw new Error(r.error);

    if (deletedOriginalIndices.has(r.index)) {
      throw new Error(`Target line ${r.index + 1} was already deleted by a prior op in this batch.`);
    }

    let adjustedIdx = r.index;
    for (const prior of appliedMeta) {
      if (prior.op === 'insert_after') {
        if (r.index > prior.originalIndex) adjustedIdx += prior.linesAdded;
        else if (r.index === prior.originalIndex && r.edit.op === 'insert_after') adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'insert_before' && r.index >= prior.originalIndex) {
        adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'replace_line') {
        if (r.index > prior.originalIndex) adjustedIdx += prior.linesAdded - 1;
      } else if (prior.op === 'delete_line' && r.index > prior.originalIndex) {
        adjustedIdx--;
      }
    }

    const edit = r.edit;
    let linesAdded = 0;
    switch (edit.op) {
      case 'replace_line': {
        const newLines = edit.content.split('\n');
        resultLines.splice(adjustedIdx, 1, ...newLines);
        linesAdded = newLines.length;
        applied.push({ op: edit.op, line: r.index + 1, linesInserted: newLines.length });
        break;
      }
      case 'insert_after': {
        const newLines = edit.content.split('\n');
        resultLines.splice(adjustedIdx + 1, 0, ...newLines);
        linesAdded = newLines.length;
        applied.push({ op: edit.op, line: adjustedIdx + 2, linesInserted: newLines.length });
        break;
      }
      case 'insert_before': {
        const newLines = edit.content.split('\n');
        resultLines.splice(adjustedIdx, 0, ...newLines);
        linesAdded = newLines.length;
        applied.push({ op: edit.op, line: adjustedIdx + 1, linesInserted: newLines.length });
        break;
      }
      case 'delete_line':
        resultLines.splice(adjustedIdx, 1);
        applied.push({ op: edit.op, line: r.index + 1 });
        break;
    }
    if (edit.op === 'delete_line') deletedOriginalIndices.add(r.index);
    appliedMeta.push({ originalIndex: r.index, op: edit.op, linesAdded });
  }

  return { content: resultLines.join('\n'), applied };
}
