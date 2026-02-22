import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renderAnchoredRange } from './hashline.mjs';
import { ensureInsideWorkspace, truncateText } from './tools.mjs';

export const MAX_FILE_REFERENCE_COUNT = 6;
export const MAX_FILE_REFERENCE_CHARS = 5_000;

function isReferenceBoundary(ch) {
  if (!ch) return true;
  return /\s|[([{\<>"'`,;]/.test(ch);
}

function trimTokenPunctuation(token) {
  let out = token;
  while (out && /[),.;!?}\]]/.test(out[out.length - 1])) {
    out = out.slice(0, -1);
  }
  return out;
}

function parseReferenceToken(token) {
  if (!token) return null;
  if (token.includes('@')) return null;

  const lineMatch = token.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  let filePath = token;
  let startLine = null;
  let endLine = null;

  if (lineMatch && lineMatch[1]) {
    filePath = lineMatch[1];
    startLine = Number(lineMatch[2]);
    endLine = lineMatch[3] ? Number(lineMatch[3]) : Number(lineMatch[2]);
    if (!Number.isInteger(startLine) || startLine < 1) return null;
    if (!Number.isInteger(endLine) || endLine < 1) return null;
    if (endLine < startLine) {
      return { token, path: filePath, startLine, endLine, invalidRange: true };
    }
  }

  if (!filePath || /\s/.test(filePath)) return null;

  return {
    token,
    path: filePath,
    startLine,
    endLine,
    invalidRange: false,
  };
}

export function parseFileReferences(text, options = {}) {
  const source = String(text || '');
  const maxCount = Number.isInteger(options.maxCount) && options.maxCount > 0
    ? options.maxCount
    : MAX_FILE_REFERENCE_COUNT;

  /** @type {Array<{token:string,path:string,startLine:number|null,endLine:number|null,invalidRange:boolean}>} */
  const refs = [];
  const seen = new Set();
  let skippedDueToLimit = 0;

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '@') continue;
    if (source[i + 1] === '@') {
      i += 1;
      continue;
    }
    if (!isReferenceBoundary(source[i - 1])) continue;

    let j = i + 1;
    while (j < source.length && !/\s/.test(source[j])) j += 1;
    const rawToken = trimTokenPunctuation(source.slice(i + 1, j));
    if (!rawToken) continue;

    const parsed = parseReferenceToken(rawToken);
    if (!parsed) continue;

    const dedupeKey = `${parsed.path}|${parsed.startLine ?? ''}|${parsed.endLine ?? ''}|${parsed.invalidRange ? '!' : ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (refs.length >= maxCount) {
      skippedDueToLimit += 1;
      continue;
    }
    refs.push(parsed);
  }

  return { refs, skippedDueToLimit };
}

function buildFileReferenceBlock({ resolved, errors, skippedDueToLimit }) {
  const header = {
    resolved: resolved.length,
    errors: errors.length,
    skipped: skippedDueToLimit,
    caps: {
      max_refs: MAX_FILE_REFERENCE_COUNT,
      max_chars_per_ref: MAX_FILE_REFERENCE_CHARS,
    },
  };

  const parts = ['[REFERENCED_FILES]', JSON.stringify(header)];

  for (const entry of resolved) {
    const meta = {
      reference: `@${entry.token}`,
      path: entry.path,
      start_line: entry.startLine,
      end_line: entry.endLine,
      total_lines: entry.totalLines,
      truncated: entry.truncated,
    };
    parts.push('[FILE_REFERENCE]');
    parts.push(JSON.stringify(meta));
    parts.push(entry.text);
    parts.push('[/FILE_REFERENCE]');
  }

  for (const err of errors) {
    parts.push('[FILE_REFERENCE_ERROR]');
    parts.push(JSON.stringify({
      reference: `@${err.token}`,
      path: err.path,
      code: err.code,
      message: err.message,
    }));
    parts.push('[/FILE_REFERENCE_ERROR]');
  }

  parts.push('[/REFERENCED_FILES]');
  return parts.join('\n');
}

function classifyReferenceError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('path escapes workspace root')) return 'PATH_ESCAPE';
  if (lower.includes('enoent') || lower.includes('no such file')) return 'NOT_FOUND';
  if (lower.includes('eisdir') || lower.includes('is a directory')) return 'IS_DIRECTORY';
  return 'READ_ERROR';
}

/**
 * Resolve @file[:line[-end]] references and build a synthetic user message block.
 * Returns `message: null` when no references were found.
 */
export async function buildFileReferenceContextMessage(text, workspaceRoot) {
  const { refs, skippedDueToLimit } = parseFileReferences(text);
  if (refs.length === 0) {
    return {
      message: null,
      parsedCount: 0,
      resolvedCount: 0,
      errorCount: 0,
      skippedCount: skippedDueToLimit,
    };
  }

  const resolved = [];
  const errors = [];
  const root = path.resolve(workspaceRoot);

  for (const ref of refs) {
    if (ref.invalidRange) {
      errors.push({
        token: ref.token,
        path: ref.path,
        code: 'INVALID_RANGE',
        message: `Invalid line range: ${ref.startLine}-${ref.endLine}`,
      });
      continue;
    }

    try {
      const filePath = await ensureInsideWorkspace(root, ref.path);
      const raw = await fs.readFile(filePath, 'utf8');
      const rendered = renderAnchoredRange(raw, ref.startLine ?? 1, ref.endLine ?? null);
      const textOut = truncateText(rendered.text, MAX_FILE_REFERENCE_CHARS);
      resolved.push({
        token: ref.token,
        path: path.relative(root, filePath) || '.',
        startLine: rendered.startLine,
        endLine: rendered.endLine,
        totalLines: rendered.totalLines,
        text: textOut,
        truncated: textOut.length < rendered.text.length,
      });
    } catch (err) {
      errors.push({
        token: ref.token,
        path: ref.path,
        code: classifyReferenceError(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    message: buildFileReferenceBlock({ resolved, errors, skippedDueToLimit }),
    parsedCount: refs.length,
    resolvedCount: resolved.length,
    errorCount: errors.length,
    skippedCount: skippedDueToLimit,
  };
}

/**
 * Push the original user message and, when present, a synthetic [REFERENCED_FILES] block.
 * `referenceSourceText` can differ from `messageText` (useful for skill-expanded prompts).
 */
export async function appendUserMessageWithFileReferences(state, messageText, workspaceRoot, options = {}) {
  state.messages.push({ role: 'user', content: messageText });

  const referenceSourceText = typeof options.referenceSourceText === 'string'
    ? options.referenceSourceText
    : messageText;

  const refs = await buildFileReferenceContextMessage(referenceSourceText, workspaceRoot);
  if (refs.message) {
    state.messages.push({ role: 'user', content: refs.message });
  }
  return refs;
}

