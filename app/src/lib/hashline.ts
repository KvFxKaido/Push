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
 * Calculate a 7-character hash for a line of text (trimmed).
 * Uses SHA-256 but truncated for brevity in tool calls.
 */
export async function calculateLineHash(line: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(line.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, 7);
}

/**
 * Apply a set of hashline edits to file content.
 */
export async function applyHashlineEdits(originalContent: string, edits: HashlineOp[]): Promise<HashlineEditResult> {
  let resultLines = originalContent.split('\n');
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
      failedCount++;
      errors.push(`Reference "${edit.ref}" is ambiguous (found ${matches.length} matches). Provide more characters or unique context.`);
      continue;
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