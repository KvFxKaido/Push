export type HashlineOp =
  | { op: 'replace_line'; ref: string; content: string }
  | { op: 'insert_after'; ref: string; content: string }
  | { op: 'insert_before'; ref: string; content: string }
  | { op: 'delete_line'; ref: string };

export interface HashlineEditResult {
  content: string;
  applied: number;
  failed: number;
  errors: string[];
  /** 1-indexed line numbers of successfully resolved edit targets (against the original content). */
  resolvedLines: number[];
}

/**
 * Parse a ref string into an optional line number and a hash.
 * Supported formats:
 *   "abc1234"        — hash only (7-12 hex chars)
 *   "12:abc1234"     — line-qualified (1-indexed line number + hash)
 * Line-qualified refs resolve unambiguously even when multiple lines
 * share identical content.
 */
function parseRef(ref: string): { lineNo: number | null; hash: string } {
  const raw = ref.trim();
  if (!raw) throw new Error('ref is required');
  const m = raw.match(/^(?:(\d+):)?([a-f0-9]{7,12})$/i);
  if (!m) throw new Error(`invalid ref format: ${raw}`);
  const lineNo = m[1] ? Number(m[1]) : null;
  const hash = m[2].toLowerCase();
  return { lineNo, hash };
}

/**
 * Calculate a hash for a line of text (trimmed).
 * Uses SHA-256 truncated to `length` hex characters (default 7) for brevity in tool calls.
 * Callers can request longer hashes (up to 12) to disambiguate collisions.
 *
 * Collision properties:
 * - 7 hex chars = 28 bits → ~50% collision chance at ~5K lines (birthday paradox).
 *   In practice most "collisions" are identical-content lines (duplicate imports,
 *   blank lines, closing braces), not hash collisions.
 * - Internal caches store 12-char (48-bit) hashes; short refs match via prefix.
 *   At 12 chars the birthday threshold is ~16M lines — effectively collision-free.
 * - When a short ref is ambiguous, the resolver suggests line-qualified refs
 *   (e.g. "42:abc1234") and distinguishes true hash ambiguity from identical
 *   content so agents can self-correct.
 */
export async function calculateLineHash(line: string, length: number = 7): Promise<string> {
  const msgUint8 = new TextEncoder().encode(line.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, Math.min(Math.max(length, 7), 12));
}

/**
 * Compute 12-char hashes for all lines in one batch.
 * We always store 12-char hashes so that any ref length (7-12) can match
 * via a prefix check without re-hashing.
 */
async function batchHashLines(lines: string[]): Promise<string[]> {
  return Promise.all(lines.map(l => calculateLineHash(l, 12)));
}

/**
 * Apply a set of hashline edits to file content.
 *
 * Two-phase approach:
 * 1. Resolve ALL refs against the original content upfront, so every op sees
 *    the same file state regardless of what earlier ops in the batch do.
 * 2. Apply resolved ops sequentially, adjusting target indices to account for
 *    line shifts from prior inserts/deletes.
 *
 * This fixes the "stale ref in same batch" bug where e.g. a replace_line
 * followed by insert_after on the same line would fail because the replace
 * changed the hash before the insert could resolve its ref.
 */
export async function applyHashlineEdits(originalContent: string, edits: HashlineOp[]): Promise<HashlineEditResult> {
  const resultLines = originalContent.split('\n');
  let appliedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  // Compute all 12-char hashes once upfront against the original content
  const hashCache = await batchHashLines(resultLines);

  /** Format a line snippet for diagnostic output (truncated at 60 chars with ellipsis). */
  function snippetOf(idx: number): string {
    const trimmed = resultLines[idx]?.trim() ?? '';
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
  }

  // --- Phase 1: Resolve all refs against the original content ---
  type ResolvedEdit = { index: number; edit: HashlineOp } | { error: string };
  const resolved: ResolvedEdit[] = [];

  for (const edit of edits) {
    let parsed: { lineNo: number | null; hash: string };
    try {
      parsed = parseRef(edit.ref);
    } catch (e) {
      resolved.push({ error: `Invalid ref "${edit.ref}": ${(e as Error).message}` });
      continue;
    }

    // Line-qualified ref — validate directly against the original line
    if (parsed.lineNo !== null) {
      const idx = parsed.lineNo - 1;
      if (idx < 0 || idx >= resultLines.length) {
        resolved.push({ error: `Line-qualified ref "${edit.ref}": line ${parsed.lineNo} is out of range (file has ${resultLines.length} lines).` });
        continue;
      }
      if (!hashCache[idx].startsWith(parsed.hash)) {
        resolved.push({ error: `Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} hash is now ${hashCache[idx].slice(0, 7)}. Re-read the file to get current hashes.` });
        continue;
      }
      resolved.push({ index: idx, edit });
      continue;
    }

    // Hash-only path: match using prefix against the original hashes
    const matches = hashCache
      .map((h, i) => h.startsWith(parsed.hash) ? i : -1)
      .filter(i => i !== -1);

    if (matches.length === 0) {
      resolved.push({ error: `Reference "${edit.ref}" not found.` });
      continue;
    }

    if (matches.length > 1) {
      // Try to disambiguate — cache already has 12-char hashes
      if (parsed.hash.length < 12) {
        const distinctGroups = new Map<string, number[]>();
        for (const idx of matches) {
          const lh = hashCache[idx];
          const group = distinctGroups.get(lh) ?? [];
          group.push(idx);
          distinctGroups.set(lh, group);
        }
        const candidateGroups = [...distinctGroups.entries()].filter(([lh]) => lh.startsWith(parsed.hash));
        if (candidateGroups.length === 1 && candidateGroups[0][1].length === 1) {
          resolved.push({ index: candidateGroups[0][1][0], edit });
        } else {
          const MAX_DIAGNOSTIC_LINES = 5;
          const diagnostics: string[] = [];
          for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
            const idx = matches[k];
            diagnostics.push(`  L${idx + 1}: ${hashCache[idx]} "${snippetOf(idx)}"`);
          }
          if (matches.length > MAX_DIAGNOSTIC_LINES) {
            diagnostics.push(`  ... and ${matches.length - MAX_DIAGNOSTIC_LINES} more`);
          }
          resolved.push({
            error: `Reference "${edit.ref}" is ambiguous (${matches.length} matches). Use a line-qualified ref (e.g. "${matches[0] + 1}:${parsed.hash}") to target a specific line:\n${diagnostics.join('\n')}`,
          });
        }
      } else {
        // Even at max hash length, lines are identical — suggest line-qualified refs
        const MAX_DIAGNOSTIC_LINES = 5;
        const diagnostics: string[] = [];
        for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
          const idx = matches[k];
          diagnostics.push(`  L${idx + 1}: "${snippetOf(idx)}"`);
        }
        resolved.push({
          error: `Reference "${edit.ref}" is ambiguous (${matches.length} matches) — lines have identical content. Use a line-qualified ref (e.g. "${matches[0] + 1}:${parsed.hash.slice(0, 7)}") to target a specific line:\n${diagnostics.join('\n')}`,
        });
      }
      continue;
    }

    resolved.push({ index: matches[0], edit });
  }

  // --- Phase 2: Apply resolved edits with offset tracking ---
  // Each applied op records its original index and op type so later ops can
  // compute their adjusted index accounting for prior inserts/deletes.
  const applied: { originalIndex: number; op: HashlineOp['op']; edit: HashlineOp }[] = [];
  const deletedOriginalIndices = new Set<number>();

  for (const r of resolved) {
    if ('error' in r) {
      failedCount++;
      errors.push(r.error);
      continue;
    }

    // Reject ops targeting a line that was already deleted in this batch
    if (deletedOriginalIndices.has(r.index)) {
      failedCount++;
      errors.push(`Target line ${r.index + 1} was already deleted by a prior op in this batch.`);
      continue;
    }

    // Compute adjusted index based on line shifts from prior ops
    let adjustedIdx = r.index;
    for (const prior of applied) {
      if (prior.op === 'insert_after') {
        if (r.index > prior.originalIndex) {
          adjustedIdx++;
        } else if (r.index === prior.originalIndex && r.edit.op === 'insert_after') {
          // Same-line insert_after stacking: shift to preserve order
          adjustedIdx++;
        }
      } else if (prior.op === 'insert_before' && r.index >= prior.originalIndex) {
        adjustedIdx++;
      } else if (prior.op === 'delete_line' && r.index > prior.originalIndex) {
        adjustedIdx--;
      }
      // replace_line doesn't shift indices
    }

    const edit = r.edit;
    switch (edit.op) {
      case 'replace_line':
        resultLines[adjustedIdx] = edit.content;
        break;
      case 'insert_after':
        resultLines.splice(adjustedIdx + 1, 0, edit.content);
        break;
      case 'insert_before':
        resultLines.splice(adjustedIdx, 0, edit.content);
        break;
      case 'delete_line':
        resultLines.splice(adjustedIdx, 1);
        break;
    }
    appliedCount++;
    if (edit.op === 'delete_line') {
      deletedOriginalIndices.add(r.index);
    }
    applied.push({ originalIndex: r.index, op: edit.op, edit });
  }

  return {
    content: resultLines.join('\n'),
    applied: appliedCount,
    failed: failedCount,
    errors,
    resolvedLines: applied.map(a => a.originalIndex + 1),
  };
}