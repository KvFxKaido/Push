/**
 * Unified hashline implementation for both Node.js and browser environments.
 * 
 * Runtime detection:
 * - Node.js: uses node:crypto.createHash (sync)
 * - Browser: uses crypto.subtle.digest (async)
 */

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

// --- Crypto runtime detection ---

function isNode(): boolean {
  return typeof process !== 'undefined' && 
         process.versions != null && 
         process.versions.node != null;
}

let cachedNodeCrypto: any = null;
export async function getNodeCrypto(): Promise<any> {
  if (cachedNodeCrypto) return cachedNodeCrypto;
  if (!isNode()) return null;
  try {
    cachedNodeCrypto = await import('node:crypto');
    return cachedNodeCrypto;
  } catch {
    return null;
  }
}

function hasWebCrypto(): boolean {
  return typeof crypto !== 'undefined' && 
         crypto.subtle != null && 
         typeof crypto.subtle.digest === 'function';
}

/**
 * Calculate a hash for a line of text (trimmed).
 * Uses SHA-256 truncated to `length` hex characters (default 7).
 *
 * Collision properties:
 * - 7 hex chars = 28 bits → ~50% collision chance at ~19K lines (birthday paradox).
 *   In practice most "collisions" are identical-content lines (duplicate imports,
 *   blank lines, closing braces), not hash collisions.
 * - Internal caches store 12-char (48-bit) hashes; short refs match via prefix.
 *   At 12 chars the birthday threshold is ~20M lines — effectively collision-free.
 * - When a short ref is ambiguous, the resolver suggests line-qualified refs
 *   (e.g. "42:abc1234") and distinguishes true hash ambiguity from identical
 *   content so agents can self-correct.
 */
export async function calculateLineHash(line: string, length: number = 7): Promise<string> {
  const trimmed = line.trim();
  
  // 1. Prefer Web Crypto (Node 19+, Browsers)
  if (hasWebCrypto()) {
    const msgUint8 = new TextEncoder().encode(trimmed);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, Math.min(Math.max(length, 7), 12));
  }
  
  // 2. Fallback to Node crypto
  const nodeCrypto = await getNodeCrypto();
  if (nodeCrypto) {
    const hash = nodeCrypto.createHash('sha256').update(trimmed).digest('hex');
    return hash.slice(0, Math.min(Math.max(length, 7), 12));
  }
  
  throw new Error('No crypto implementation available');
}

/**
 * Sync version for Node.js contexts where async isn't practical.
 */
export function calculateLineHashSync(line: string, length: number = 7): string {
  const trimmed = line.trim();
  
  if (cachedNodeCrypto) {
    const hash = cachedNodeCrypto.createHash('sha256').update(trimmed).digest('hex');
    return hash.slice(0, Math.min(Math.max(length, 7), 12));
  }
  
  throw new Error('calculateLineHashSync requires getNodeCrypto() to be called once first in ESM');
}

/**
 * Calculate a content version hash (used for file versioning).
 * Universal implementation using Web Crypto or Node.js fallback.
 */
export async function calculateContentVersion(content: string): Promise<string> {
  const str = String(content);

  // 1. Prefer Web Crypto
  if (hasWebCrypto()) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  }

  // 2. Fallback to Node crypto
  const nodeCrypto = await getNodeCrypto();
  if (nodeCrypto) {
    return nodeCrypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
  }

  throw new Error('No crypto implementation available');
}

// --- Ref parsing ---

function parseRef(ref: string): { lineNo: number | null; hash: string } {
  const raw = ref.trim();
  if (!raw) throw new Error('ref is required');
  const m = raw.match(/^(?:(\d+)[:|])?([a-f0-9]{7,12})$/i);
  if (!m) throw new Error(`invalid ref format: ${raw}`);
  const lineNo = m[1] ? Number(m[1]) : null;
  const hash = m[2].toLowerCase();
  return { lineNo, hash };
}

async function batchHashLines(lines: string[]): Promise<string[]> {
  const nodeCrypto = await getNodeCrypto();
  if (nodeCrypto) {
    // Optimization: In Node, sync hashing in a loop is much faster for batches
    // than thousands of async Promise.all calls (handles 2k+ lines efficiently).
    return lines.map(line => {
      const hash = nodeCrypto.createHash('sha256').update(line.trim()).digest('hex');
      return hash.slice(0, 12);
    });
  }
  return Promise.all(lines.map(l => calculateLineHash(l, 12)));
}

/**
 * Apply a set of hashline edits to file content.
 */
export async function applyHashlineEdits(originalContent: string, edits: HashlineOp[]): Promise<HashlineEditResult> {
  const resultLines = originalContent.split('\n');
  let appliedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  const hashCache = await batchHashLines(resultLines);

  /** Format a line snippet for diagnostic output (truncated at 60 chars with ellipsis). */
  function snippetOf(idx: number): string {
    const trimmed = resultLines[idx]?.trim() ?? '';
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
  }

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

  const applied: { originalIndex: number; op: HashlineOp['op']; edit: HashlineOp; linesAdded: number }[] = [];
  const deletedOriginalIndices = new Set<number>();

  for (const r of resolved) {
    if ('error' in r) {
      failedCount++;
      errors.push(r.error);
      continue;
    }

    if (deletedOriginalIndices.has(r.index)) {
      failedCount++;
      errors.push(`Target line ${r.index + 1} was already deleted by a prior op in this batch.`);
      continue;
    }

    // Offset adjustment logic (honors array order for same-line inserts/deletes).
    // Each prior op may shift the target by more than 1 line when content is multi-line.
    let adjustedIdx = r.index;
    for (const prior of applied) {
      if (prior.op === 'insert_after') {
        if (r.index > prior.originalIndex) adjustedIdx += prior.linesAdded;
        else if (r.index === prior.originalIndex && r.edit.op === 'insert_after') adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'insert_before' && r.index >= prior.originalIndex) {
        adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'replace_line') {
        // replace_line with multi-line content adds (N-1) extra lines
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
        break;
      }
      case 'insert_after': {
        const newLines = edit.content.split('\n');
        resultLines.splice(adjustedIdx + 1, 0, ...newLines);
        linesAdded = newLines.length;
        break;
      }
      case 'insert_before': {
        const newLines = edit.content.split('\n');
        resultLines.splice(adjustedIdx, 0, ...newLines);
        linesAdded = newLines.length;
        break;
      }
      case 'delete_line':
        resultLines.splice(adjustedIdx, 1);
        break;
    }
    appliedCount++;
    if (edit.op === 'delete_line') deletedOriginalIndices.add(r.index);
    applied.push({ originalIndex: r.index, op: edit.op, edit, linesAdded });
  }

  return { content: resultLines.join('\n'), applied: appliedCount, failed: failedCount, errors, resolvedLines: applied.map(a => a.originalIndex + 1) };
}

/**
 * Render content with anchored line numbers and hashes.
 */
export async function renderAnchoredRange(
  content: string, 
  startLine: number = 1, 
  endLine: number | null = null
): Promise<{ text: string; startLine: number; endLine: number; totalLines: number }> {
  const lines = String(content).split(/\r?\n/);
  const totalLines = lines.length || 1;
  const start = Math.max(1, Math.min(Number(startLine) || 1, totalLines));
  const end = Math.max(start, Math.min(Number(endLine) || totalLines, totalLines));
  const hashes = await batchHashLines(lines);

  const out = [];
  for (let i = start - 1; i < end; i++) {
    out.push(`${i + 1}|${hashes[i]}| ${lines[i]}`);
  }

  return { text: out.join('\n') || '<empty file>', startLine: start, endLine: end, totalLines };
}