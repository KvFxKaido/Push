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
 * Uses a hash cache to avoid recomputing all line hashes for every edit.
 * Hashes are computed once upfront (O(n)) and surgically updated after
 * each edit. The per-edit linear scan to find matching hashes is O(n),
 * so total cost is O(n + n·m) — but this eliminates the dominant cost
 * of O(n·m) SHA-256 recomputations from the original implementation.
 */
export async function applyHashlineEdits(originalContent: string, edits: HashlineOp[]): Promise<HashlineEditResult> {
  const resultLines = originalContent.split('\n');
  let appliedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  // Compute all 12-char hashes once upfront
  const hashCache = await batchHashLines(resultLines);

  for (const edit of edits) {
    // Parse ref — supports bare hash ("abc1234") and line-qualified ("12:abc1234")
    let parsed: { lineNo: number | null; hash: string };
    try {
      parsed = parseRef(edit.ref);
    } catch (e) {
      failedCount++;
      errors.push(`Invalid ref "${edit.ref}": ${(e as Error).message}`);
      continue;
    }

    // Fast path: line-qualified ref — go directly to the line, validate hash
    if (parsed.lineNo !== null) {
      const idx = parsed.lineNo - 1;
      if (idx < 0 || idx >= resultLines.length) {
        failedCount++;
        errors.push(`Line-qualified ref "${edit.ref}": line ${parsed.lineNo} is out of range (file has ${resultLines.length} lines).`);
        continue;
      }
      if (!hashCache[idx].startsWith(parsed.hash)) {
        failedCount++;
        errors.push(`Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} hash is now ${hashCache[idx].slice(0, 7)}. Re-read the file to get current hashes.`);
        continue;
      }
      // Resolved — fall through to apply
      const targetIndex = idx;

      switch (edit.op) {
        case 'replace_line':
          resultLines[targetIndex] = edit.content;
          hashCache[targetIndex] = await calculateLineHash(edit.content, 12);
          appliedCount++;
          break;
        case 'insert_after':
          resultLines.splice(targetIndex + 1, 0, edit.content);
          hashCache.splice(targetIndex + 1, 0, await calculateLineHash(edit.content, 12));
          appliedCount++;
          break;
        case 'insert_before':
          resultLines.splice(targetIndex, 0, edit.content);
          hashCache.splice(targetIndex, 0, await calculateLineHash(edit.content, 12));
          appliedCount++;
          break;
        case 'delete_line':
          resultLines.splice(targetIndex, 1);
          hashCache.splice(targetIndex, 1);
          appliedCount++;
          break;
      }
      continue;
    }

    // Hash-only path: match using prefix
    const matches = hashCache
      .map((h, i) => h.startsWith(parsed.hash) ? i : -1)
      .filter(i => i !== -1);

    if (matches.length === 0) {
      failedCount++;
      errors.push(`Reference "${edit.ref}" not found.`);
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
          matches.splice(0, matches.length, candidateGroups[0][1][0]);
        } else {
          const MAX_DIAGNOSTIC_LINES = 5;
          const diagnostics: string[] = [];
          for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
            const idx = matches[k];
            const snippet = resultLines[idx].trim().slice(0, 60);
            const longerRef = hashCache[idx];
            diagnostics.push(`  L${idx + 1}: ${longerRef} "${snippet}${resultLines[idx].trim().length > 60 ? '…' : ''}"`);
          }
          if (matches.length > MAX_DIAGNOSTIC_LINES) {
            diagnostics.push(`  ... and ${matches.length - MAX_DIAGNOSTIC_LINES} more`);
          }
          failedCount++;
          errors.push(
            `Reference "${edit.ref}" is ambiguous (${matches.length} matches). Use a line-qualified ref (e.g. "${matches[0] + 1}:${parsed.hash}") to target a specific line:\n${diagnostics.join('\n')}`
          );
          continue;
        }
      } else {
        // Even at max hash length, lines are identical — suggest line-qualified refs
        const MAX_DIAGNOSTIC_LINES = 5;
        const diagnostics: string[] = [];
        for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
          const idx = matches[k];
          diagnostics.push(`  L${idx + 1}: "${resultLines[idx].trim().slice(0, 60)}"`);
        }
        failedCount++;
        errors.push(
          `Reference "${edit.ref}" is ambiguous (${matches.length} matches) — lines have identical content. Use a line-qualified ref (e.g. "${matches[0] + 1}:${parsed.hash.slice(0, 7)}") to target a specific line:\n${diagnostics.join('\n')}`
        );
        continue;
      }
    }

    const targetIndex = matches[0];

    switch (edit.op) {
      case 'replace_line':
        resultLines[targetIndex] = edit.content;
        // Update only the replaced line's hash
        hashCache[targetIndex] = await calculateLineHash(edit.content, 12);
        appliedCount++;
        break;
      case 'insert_after':
        resultLines.splice(targetIndex + 1, 0, edit.content);
        // Insert the new line's hash at the corresponding position
        hashCache.splice(targetIndex + 1, 0, await calculateLineHash(edit.content, 12));
        appliedCount++;
        break;
      case 'insert_before':
        resultLines.splice(targetIndex, 0, edit.content);
        hashCache.splice(targetIndex, 0, await calculateLineHash(edit.content, 12));
        appliedCount++;
        break;
      case 'delete_line':
        resultLines.splice(targetIndex, 1);
        hashCache.splice(targetIndex, 1);
        appliedCount++;
        break;
    }
  }

  return {
    content: resultLines.join('\n'),
    applied: appliedCount,
    failed: failedCount,
    errors
  };
}