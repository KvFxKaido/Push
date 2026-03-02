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
 * Apply a set of hashline edits to file content.
 */
export async function applyHashlineEdits(originalContent: string, edits: HashlineOp[]): Promise<HashlineEditResult> {
  const resultLines = originalContent.split('\n');
  let appliedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const edit of edits) {
    // Re-calculate hashes since the file might have changed from previous edit
    const currentHashes = await Promise.all(resultLines.map(calculateLineHash));
    const matches = currentHashes.map((h, i) => h.startsWith(edit.ref) ? i : -1).filter(i => i !== -1);

    if (matches.length === 0) {
      failedCount++;
      errors.push(`Reference "${edit.ref}" not found.`);
      continue;
    }

    if (matches.length > 1) {
      // Try to disambiguate with longer hashes (up to 12 chars)
      if (edit.ref.length < 12) {
        const longerHashes = await Promise.all(matches.map(i => calculateLineHash(resultLines[i], 12)));
        // Group by distinct longer hash to find unique prefixes
        const distinctGroups = new Map<string, number[]>();
        for (let k = 0; k < matches.length; k++) {
          const lh = longerHashes[k];
          const group = distinctGroups.get(lh) ?? [];
          group.push(matches[k]);
          distinctGroups.set(lh, group);
        }
        // Find groups whose longer hash still starts with the provided ref
        const candidateGroups = [...distinctGroups.entries()].filter(([lh]) => lh.startsWith(edit.ref));
        if (candidateGroups.length === 1 && candidateGroups[0][1].length === 1) {
          // Exactly one line after disambiguation — use it
          matches.splice(0, matches.length, candidateGroups[0][1][0]);
        } else {
          // Still ambiguous — provide diagnostic context with line numbers and longer hashes
          const MAX_DIAGNOSTIC_LINES = 5;
          const diagnostics: string[] = [];
          for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
            const idx = matches[k];
            const snippet = resultLines[idx].trim().slice(0, 60);
            const longerRef = longerHashes[k];
            diagnostics.push(`  L${idx + 1}: ${longerRef} "${snippet}${resultLines[idx].trim().length > 60 ? '…' : ''}"`);
          }
          if (matches.length > MAX_DIAGNOSTIC_LINES) {
            diagnostics.push(`  ... and ${matches.length - MAX_DIAGNOSTIC_LINES} more`);
          }
          failedCount++;
          errors.push(
            `Reference "${edit.ref}" is ambiguous (${matches.length} matches). Use a longer hash prefix (up to 12 chars) to disambiguate:\n${diagnostics.join('\n')}`
          );
          continue;
        }
      } else {
        failedCount++;
        errors.push(`Reference "${edit.ref}" is ambiguous (${matches.length} matches) even at max length. Lines have identical trimmed content.`);
        continue;
      }
    }

    const targetIndex = matches[0];

    switch (edit.op) {
      case 'replace_line':
        resultLines[targetIndex] = edit.content;
        appliedCount++;
        break;
      case 'insert_after':
        resultLines.splice(targetIndex + 1, 0, edit.content);
        appliedCount++;
        break;
      case 'insert_before':
        resultLines.splice(targetIndex, 0, edit.content);
        appliedCount++;
        break;
      case 'delete_line':
        resultLines.splice(targetIndex, 1);
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