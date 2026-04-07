/**
 * Unified hashline implementation for both Node.js and browser environments.
 *
 * Runtime detection:
 * - Preferred: Web Crypto SHA-256 when available
 * - Fallback: deterministic JS hash for environments without Web Crypto
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

function getWebCrypto(): Crypto | null {
  const candidate = globalThis.crypto;
  return candidate && candidate.subtle ? candidate : null;
}

function hasWebCrypto(): boolean {
  const webCrypto = getWebCrypto();
  return webCrypto != null && typeof webCrypto.subtle.digest === 'function';
}

function fallbackHashHex(input: string): string {
  // Deterministic non-cryptographic fallback used only when Web Crypto is absent.
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b1;

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    primary ^= code;
    primary = Math.imul(primary, 0x01000193);
    secondary ^= code;
    secondary = Math.imul(secondary, 0x85ebca6b);
  }

  return `${(primary >>> 0).toString(16).padStart(8, '0')}${(secondary >>> 0).toString(16).padStart(8, '0')}`;
}

function clampHashLength(length: number): number {
  return Math.min(Math.max(length, 7), 12);
}

export async function getNodeCrypto(): Promise<null> {
  return null;
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

  // 1. Prefer Web Crypto (modern browsers + current Node runtimes)
  if (hasWebCrypto()) {
    const webCrypto = getWebCrypto();
    if (!webCrypto) throw new Error('Web Crypto disappeared during hashing');
    const msgUint8 = new TextEncoder().encode(trimmed);
    const hashBuffer = await webCrypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, clampHashLength(length));
  }

  return fallbackHashHex(trimmed).slice(0, clampHashLength(length));
}

/**
 * Sync version for legacy utility callers. Uses the deterministic JS fallback.
 */
export function calculateLineHashSync(line: string, length: number = 7): string {
  return fallbackHashHex(line.trim()).slice(0, clampHashLength(length));
}

/**
 * Calculate a content version hash (used for file versioning).
 * Universal implementation using Web Crypto or Node.js fallback.
 */
export async function calculateContentVersion(content: string): Promise<string> {
  const str = String(content);

  // 1. Prefer Web Crypto
  if (hasWebCrypto()) {
    const webCrypto = getWebCrypto();
    if (!webCrypto) throw new Error('Web Crypto disappeared during content hashing');
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await webCrypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  }

  return fallbackHashHex(str).slice(0, 12);
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
        const refreshedRef = `${parsed.lineNo}:${hashCache[idx].slice(0, parsed.hash.length)}`;
        resolved.push({
          error: `Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} hash is now ${hashCache[idx].slice(0, 7)}. Retry with "${refreshedRef}" to target the same line, or re-read the file if the intended content moved.`,
        });
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
            const retryRefs: string[] = [];
            for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
              const idx = matches[k];
              diagnostics.push(`  L${idx + 1}: ${hashCache[idx]} "${snippetOf(idx)}"`);
              retryRefs.push(`"${idx + 1}:${hashCache[idx].slice(0, parsed.hash.length)}"`);
            }
            if (matches.length > MAX_DIAGNOSTIC_LINES) {
              diagnostics.push(`  ... and ${matches.length - MAX_DIAGNOSTIC_LINES} more`);
            }
            resolved.push({
            error: `Reference "${edit.ref}" is ambiguous (${matches.length} matches). Retry with a line-qualified ref such as ${retryRefs.join(', ')}:\n${diagnostics.join('\n')}`,
            });
          }
      } else {
        // Even at max hash length, lines are identical — suggest line-qualified refs
        const MAX_DIAGNOSTIC_LINES = 5;
        const diagnostics: string[] = [];
        const retryRefs: string[] = [];
        for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
          const idx = matches[k];
          diagnostics.push(`  L${idx + 1}: "${snippetOf(idx)}"`);
          retryRefs.push(`"${idx + 1}:${parsed.hash.slice(0, 7)}"`);
        }
        resolved.push({
          error: `Reference "${edit.ref}" is ambiguous (${matches.length} matches) — lines have identical content. Retry with a line-qualified ref such as ${retryRefs.join(', ')}:\n${diagnostics.join('\n')}`,
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
        if (r.index > prior.originalIndex) {
          adjustedIdx += prior.linesAdded - 1;
        } else if (r.index === prior.originalIndex && r.edit.op === 'insert_after') {
          // insert_after the same line that was replaced: shift past the full replaced block
          adjustedIdx += prior.linesAdded - 1;
        }
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
