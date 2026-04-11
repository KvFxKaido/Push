/**
 * CLI hashline adapter — sync Node.js wrappers over the shared hashline engine.
 *
 * Crypto: sync Node.js `createHash` (no async boundary).
 * Resolution + application: delegates to the shared `resolveHashlineRefs` and
 * `applyResolvedHashlineEdits` exported from lib/hashline.ts — one
 * implementation, zero duplication.
 */
import { createHash } from 'node:crypto';
import {
  type HashlineOp,
  adaptiveHashDisplayLength,
  resolveHashlineRefs,
  applyResolvedHashlineEdits,
} from '../lib/hashline.ts';

export type { HashlineOp };

// ---------------------------------------------------------------------------
// Sync hashing (CLI-specific convenience)
// ---------------------------------------------------------------------------

export function calculateLineHash(line: unknown, length: number = 7): string {
  return createHash('sha256')
    .update(String(line).trim())
    .digest('hex')
    .slice(0, Math.min(Math.max(length, 7), 12));
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
  const fullHashes = lines.map((l) => calculateLineHash(l, 12));
  const rangeHashes = fullHashes.slice(start - 1, end);
  const displayLen = adaptiveHashDisplayLength(rangeHashes);

  const out: string[] = [];
  for (let i = start - 1; i < end; i++) {
    out.push(`${i + 1}:${fullHashes[i].slice(0, displayLen)}\t${lines[i]}`);
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
  warnings: string[];
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
      return {
        op,
        ref,
        content: (edit as Record<string, unknown>).content as string,
      } as HashlineOp;
    }
    if (op === 'delete_line') {
      return { op, ref } as HashlineOp;
    }
    throw new Error(`unsupported edit op: ${op}`);
  });

  // Sync crypto, shared resolution + application engine
  const resultLines = String(content).split('\n');
  const hashCache = resultLines.map((l) =>
    createHash('sha256').update(l.trim()).digest('hex').slice(0, 12),
  );

  const resolved = resolveHashlineRefs(hashCache, resultLines, validated);

  // CLI policy: throw on first resolution error (strict mode)
  for (const r of resolved) {
    if ('error' in r) throw new Error(r.error);
  }

  const result = applyResolvedHashlineEdits(resultLines, resolved);

  // CLI policy: throw on any application error
  if (result.failed > 0) {
    throw new Error(result.errors[0]);
  }

  // Transform to CLI-specific shape
  const applied: AppliedEdit[] = result.appliedDetails.map((d) => {
    const base: AppliedEdit = { op: d.op, line: d.adjustedLine };
    if (d.op === 'insert_after') {
      // CLI convention: insert_after reports the line *after* the anchor
      base.line = d.adjustedLine + 1;
    }
    if (d.linesAdded > 0) base.linesInserted = d.linesAdded;
    return base;
  });

  return { content: result.content, applied, warnings: result.warnings };
}
