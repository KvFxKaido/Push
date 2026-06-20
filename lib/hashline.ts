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

export type HashlineDiagnosticCode =
  | 'stale_ref_relocated'
  | 'stale_ref_ambiguous'
  | 'stale_ref_mismatch'
  | 'double_replace_warning';

export interface HashlineDiagnostic {
  code: HashlineDiagnosticCode;
  message: string;
}

export interface HashlineEditResult {
  content: string;
  applied: number;
  failed: number;
  errors: string[];
  warnings: string[];
  errorDetails: HashlineDiagnostic[];
  warningDetails: HashlineDiagnostic[];
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

export function normalizeLineForHash(line: string): string {
  return String(line).trim();
}

export async function getNodeCrypto(): Promise<null> {
  return null;
}

export async function calculateLineHash(line: string, length: number = 7): Promise<string> {
  const normalized = normalizeLineForHash(line);

  if (hasWebCrypto()) {
    const webCrypto = getWebCrypto();
    if (!webCrypto) throw new Error('Web Crypto disappeared during hashing');
    const msgUint8 = new TextEncoder().encode(normalized);
    const hashBuffer = await webCrypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, clampHashLength(length));
  }

  return fallbackHashHex(normalized).slice(0, clampHashLength(length));
}

export function calculateLineHashSync(line: string, length: number = 7): string {
  return fallbackHashHex(normalizeLineForHash(line)).slice(0, clampHashLength(length));
}

export function adaptiveHashDisplayLength(fullHashes: string[], minLength: number = 7): number {
  if (fullHashes.length <= 10) return minLength;
  for (let len = minLength; len <= 10; len++) {
    const sliced = fullHashes.map((h) => h.slice(0, len));
    if (new Set(sliced).size / sliced.length >= 0.95) return len;
  }
  return 10;
}

export async function calculateContentVersion(content: string): Promise<string> {
  const str = String(content);

  if (hasWebCrypto()) {
    const webCrypto = getWebCrypto();
    if (!webCrypto) throw new Error('Web Crypto disappeared during content hashing');
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await webCrypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  }

  return fallbackHashHex(str).slice(0, 12);
}

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
  return Promise.all(lines.map((l) => calculateLineHash(l, 12)));
}

export type ResolvedEdit =
  | { index: number; edit: HashlineOp; warning?: HashlineDiagnostic }
  | { error: string; errorCode?: HashlineDiagnosticCode };

const STALE_REF_RELOCATION_WINDOW = 25;

type StaleRefRelocation =
  | { kind: 'relocated'; index: number }
  | { kind: 'ambiguous'; indices: number[] }
  | { kind: 'none' };

function relocateStaleRef(
  hashCache: string[],
  originalIdx: number,
  hashPrefix: string,
): StaleRefRelocation {
  const matches: number[] = [];
  for (let i = 0; i < hashCache.length; i++) {
    if (i === originalIdx) continue;
    if (hashCache[i].startsWith(hashPrefix)) matches.push(i);
  }
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', indices: matches };
  const target = matches[0];
  if (Math.abs(target - originalIdx) <= STALE_REF_RELOCATION_WINDOW) {
    return { kind: 'relocated', index: target };
  }
  return { kind: 'none' };
}

export function resolveHashlineRefs(
  hashCache: string[],
  lines: string[],
  edits: HashlineOp[],
): ResolvedEdit[] {
  function snippetOf(idx: number): string {
    const trimmed = lines[idx]?.trim() ?? '';
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
  }

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
      if (idx < 0) {
        resolved.push({
          error: `Line-qualified ref "${edit.ref}": line ${parsed.lineNo} is out of range (file has ${lines.length} lines).`,
        });
        continue;
      }
      if (idx >= lines.length) {
        const relocation = relocateStaleRef(hashCache, idx, parsed.hash);
        if (relocation.kind === 'relocated') {
          const delta = relocation.index - idx;
          resolved.push({
            index: relocation.index,
            edit,
            warning: {
              code: 'stale_ref_relocated',
              message: `Stale anchor "${edit.ref}": line ${parsed.lineNo} is now out of range (file has ${lines.length} lines), but the anchored content was found ${Math.abs(delta)} line${Math.abs(delta) === 1 ? '' : 's'} earlier at line ${relocation.index + 1}. Relocated the edit there — verify it targeted the intended line.`,
            },
          });
          continue;
        }
        if (relocation.kind === 'ambiguous') {
          const shown = relocation.indices.slice(0, 5);
          const retryRefs = shown.map((i) => `"${i + 1}:${hashCache[i].slice(0, 7)}"`);
          const more =
            relocation.indices.length > shown.length
              ? ` (and ${relocation.indices.length - shown.length} more)`
              : '';
          resolved.push({
            error: `Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} is now out of range (file has ${lines.length} lines), and the anchored content still appears at multiple other lines${more}, so the line number can no longer disambiguate it. Re-read and retry with a fresh line-qualified ref such as ${retryRefs.join(', ')}.`,
            errorCode: 'stale_ref_ambiguous',
          });
          continue;
        }
        resolved.push({
          error: `Line-qualified ref "${edit.ref}": line ${parsed.lineNo} is out of range (file has ${lines.length} lines).`,
        });
        continue;
      }
      if (!hashCache[idx].startsWith(parsed.hash)) {
        const relocation = relocateStaleRef(hashCache, idx, parsed.hash);
        if (relocation.kind === 'relocated') {
          const delta = relocation.index - idx;
          const direction = delta < 0 ? 'earlier' : 'later';
          resolved.push({
            index: relocation.index,
            edit,
            warning: {
              code: 'stale_ref_relocated',
              message: `Stale anchor "${edit.ref}": line ${parsed.lineNo} no longer matches, but the anchored content was found ${Math.abs(delta)} line${Math.abs(delta) === 1 ? '' : 's'} ${direction} at line ${relocation.index + 1}. Relocated the edit there — verify it targeted the intended line.`,
            },
          });
          continue;
        }
        if (relocation.kind === 'ambiguous') {
          const shown = relocation.indices.slice(0, 5);
          const retryRefs = shown.map((i) => `"${i + 1}:${hashCache[i].slice(0, 7)}"`);
          const more =
            relocation.indices.length > shown.length
              ? ` (and ${relocation.indices.length - shown.length} more)`
              : '';
          resolved.push({
            error: `Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} no longer matches, and the anchored content still appears at multiple other lines${more}, so the line number can no longer disambiguate it. Re-read and retry with a fresh line-qualified ref such as ${retryRefs.join(', ')}.`,
            errorCode: 'stale_ref_ambiguous',
          });
          continue;
        }
        const refreshedRef = `${parsed.lineNo}:${hashCache[idx].slice(0, parsed.hash.length)}`;
        resolved.push({
          error: `Stale line-qualified ref "${edit.ref}": line ${parsed.lineNo} hash is now ${hashCache[idx].slice(0, 7)}. Retry with "${refreshedRef}" to target the same line, or re-read the file if the intended content moved.`,
          errorCode: 'stale_ref_mismatch',
        });
        continue;
      }
      resolved.push({ index: idx, edit });
      continue;
    }

    const matches = hashCache
      .map((h, i) => (h.startsWith(parsed.hash) ? i : -1))
      .filter((i) => i !== -1);

    if (matches.length === 0) {
      resolved.push({ error: `Reference "${edit.ref}" not found.` });
      continue;
    }

    if (matches.length > 1) {
      if (parsed.hash.length < 12) {
        const distinctGroups = new Map<string, number[]>();
        for (const idx of matches) {
          const lh = hashCache[idx];
          const group = distinctGroups.get(lh) ?? [];
          group.push(idx);
          distinctGroups.set(lh, group);
        }
        const candidateGroups = [...distinctGroups.entries()].filter(([lh]) =>
          lh.startsWith(parsed.hash),
        );
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
        const MAX_DIAGNOSTIC_LINES = 5;
        const diagnostics: string[] = [];
        const retryRefs: string[] = [];
        for (let k = 0; k < Math.min(matches.length, MAX_DIAGNOSTIC_LINES); k++) {
          const idx = matches[k];
          diagnostics.push(`  L${idx + 1}: "${snippetOf(idx)}"`);
          retryRefs.push(`"${idx + 1}:${parsed.hash.slice(0, 7)}"`);
        }
        resolved.push({
          error: `Reference "${edit.ref}" is ambiguous (${matches.length} matches) — lines have identical trimmed content. Retry with a line-qualified ref such as ${retryRefs.join(', ')}:\n${diagnostics.join('\n')}`,
        });
      }
      continue;
    }

    resolved.push({ index: matches[0], edit });
  }

  return resolved;
}

export interface AppliedEditDetail {
  originalIndex: number;
  op: HashlineOp['op'];
  adjustedLine: number;
  linesAdded: number;
}

export function applyResolvedHashlineEdits(
  resultLines: string[],
  resolved: ResolvedEdit[],
): HashlineEditResult & { appliedDetails: AppliedEditDetail[] } {
  let appliedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const errorDetails: HashlineDiagnostic[] = [];
  const warningDetails: HashlineDiagnostic[] = [];
  const applied: (AppliedEditDetail & { edit: HashlineOp })[] = [];
  const deletedOriginalIndices = new Set<number>();
  const replacedOriginalIndices = new Set<number>();

  for (const r of resolved) {
    if ('error' in r) {
      failedCount++;
      errors.push(r.error);
      if (r.errorCode) errorDetails.push({ code: r.errorCode, message: r.error });
      continue;
    }

    if (deletedOriginalIndices.has(r.index)) {
      failedCount++;
      errors.push(`Target line ${r.index + 1} was already deleted by a prior op in this batch.`);
      continue;
    }

    if (replacedOriginalIndices.has(r.index) && r.edit.op === 'replace_line') {
      const warningMessage = `Line ${r.index + 1} was already replaced by a prior op in this batch — the second replace targets the mutated content, which is usually unintended.`;
      warnings.push(warningMessage);
      warningDetails.push({ code: 'double_replace_warning', message: warningMessage });
    }

    let adjustedIdx = r.index;
    for (const prior of applied) {
      if (prior.op === 'insert_after') {
        if (r.index > prior.originalIndex) adjustedIdx += prior.linesAdded;
        else if (r.index === prior.originalIndex && r.edit.op === 'insert_after')
          adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'insert_before' && r.index >= prior.originalIndex) {
        adjustedIdx += prior.linesAdded;
      } else if (prior.op === 'replace_line') {
        if (r.index > prior.originalIndex) {
          adjustedIdx += prior.linesAdded - 1;
        } else if (r.index === prior.originalIndex && r.edit.op === 'insert_after') {
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
      case 'delete_line': {
        resultLines.splice(adjustedIdx, 1);
        deletedOriginalIndices.add(r.index);
        linesAdded = 0;
        break;
      }
    }

    if (edit.op === 'replace_line') replacedOriginalIndices.add(r.index);

    appliedCount++;
    applied.push({
      originalIndex: r.index,
      op: edit.op,
      adjustedLine: adjustedIdx + 1,
      linesAdded,
      edit,
    });
    if (r.warning) {
      warnings.push(r.warning.message);
      warningDetails.push(r.warning);
    }
  }

  return {
    content: resultLines.join('\n'),
    applied: appliedCount,
    failed: failedCount,
    errors,
    warnings,
    errorDetails,
    warningDetails,
    resolvedLines: applied.map((a) => a.originalIndex + 1),
    appliedDetails: applied.map(({ originalIndex, op, adjustedLine, linesAdded }) => ({
      originalIndex,
      op,
      adjustedLine,
      linesAdded,
    })),
  };
}

export async function applyHashlineEdits(
  originalContent: string,
  edits: HashlineOp[],
): Promise<HashlineEditResult> {
  const resultLines = originalContent.split('\n');
  const hashCache = await batchHashLines(resultLines);
  const resolved = resolveHashlineRefs(hashCache, resultLines, edits);
  return applyResolvedHashlineEdits(resultLines, resolved);
}

export async function renderAnchoredRange(
  content: string,
  startLine: number = 1,
  endLine: number | null = null,
): Promise<{ text: string; startLine: number; endLine: number; totalLines: number }> {
  const lines = String(content).split(/\r?\n/);
  const totalLines = lines.length || 1;
  const start = Math.max(1, Math.min(Number(startLine) || 1, totalLines));
  const end = Math.max(start, Math.min(Number(endLine) || totalLines, totalLines));
  const hashes = await batchHashLines(lines);
  const rangeHashes = hashes.slice(start - 1, end);
  const displayLen = adaptiveHashDisplayLength(rangeHashes);

  const out: string[] = [];
  for (let i = start - 1; i < end; i++) {
    const lineNo = i + 1;
    const hash = hashes[i].slice(0, displayLen);
    out.push(`${lineNo.toString().padStart(String(end).length, ' ')}:${hash}\t${lines[i] ?? ''}`);
  }

  return { text: out.join('\n') || '<empty file>', startLine: start, endLine: end, totalLines };
}
