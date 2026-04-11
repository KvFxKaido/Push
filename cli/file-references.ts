import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renderAnchoredRange } from './hashline.js';
import { ensureInsideWorkspace, truncateText } from './tools.js';

export const MAX_FILE_REFERENCE_COUNT = 6;
export const MAX_FILE_REFERENCE_CHARS = 5_000;

export interface ParsedReference {
  token: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  invalidRange: boolean;
}

export interface ParseFileReferencesResult {
  refs: ParsedReference[];
  skippedDueToLimit: number;
}

export interface ParseFileReferencesOptions {
  maxCount?: number;
}

interface ResolvedEntry {
  token: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
}

interface ReferenceError {
  token: string;
  path: string;
  code: string;
  message: string;
}

interface BuildBlockInput {
  resolved: ResolvedEntry[];
  errors: ReferenceError[];
  skippedDueToLimit: number;
}

export interface FileReferenceContextResult {
  message: string | null;
  parsedCount: number;
  resolvedCount: number;
  errorCount: number;
  skippedCount: number;
}

interface AppendOptions {
  referenceSourceText?: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatState {
  messages: ChatMessage[];
}

function isReferenceBoundary(ch: string | undefined): boolean {
  if (!ch) return true;
  return /\s|[([{\<>"'`,;]/.test(ch);
}

function trimTokenPunctuation(token: string): string {
  let out = token;
  while (out && /[),.;!?}\]]/.test(out[out.length - 1])) {
    out = out.slice(0, -1);
  }
  return out;
}

function parseReferenceToken(token: string): ParsedReference | null {
  if (!token) return null;
  if (token.includes('@')) return null;

  const lineMatch = token.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  let filePath: string = token;
  let startLine: number | null = null;
  let endLine: number | null = null;

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

export function parseFileReferences(
  text: string,
  options: ParseFileReferencesOptions = {},
): ParseFileReferencesResult {
  const source: string = String(text || '');
  const maxCount: number =
    Number.isInteger(options.maxCount) && (options.maxCount as number) > 0
      ? (options.maxCount as number)
      : MAX_FILE_REFERENCE_COUNT;

  const refs: ParsedReference[] = [];
  const seen = new Set<string>();
  let skippedDueToLimit = 0;

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '@') continue;
    if (source[i + 1] === '@') {
      i += 1;
      continue;
    }
    if (!isReferenceBoundary(source[i - 1])) continue;

    let j: number = i + 1;
    while (j < source.length && !/\s/.test(source[j])) j += 1;
    const rawToken: string = trimTokenPunctuation(source.slice(i + 1, j));
    if (!rawToken) continue;

    const parsed: ParsedReference | null = parseReferenceToken(rawToken);
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

function buildFileReferenceBlock({ resolved, errors, skippedDueToLimit }: BuildBlockInput): string {
  const header = {
    resolved: resolved.length,
    errors: errors.length,
    skipped: skippedDueToLimit,
    caps: {
      max_refs: MAX_FILE_REFERENCE_COUNT,
      max_chars_per_ref: MAX_FILE_REFERENCE_CHARS,
    },
  };

  const parts: string[] = ['[REFERENCED_FILES]', JSON.stringify(header)];

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
    parts.push(
      JSON.stringify({
        reference: `@${err.token}`,
        path: err.path,
        code: err.code,
        message: err.message,
      }),
    );
    parts.push('[/FILE_REFERENCE_ERROR]');
  }

  parts.push('[/REFERENCED_FILES]');
  return parts.join('\n');
}

function classifyReferenceError(err: unknown): string {
  const message: string = err instanceof Error ? err.message : String(err);
  const lower: string = message.toLowerCase();
  if (lower.includes('path escapes workspace root')) return 'PATH_ESCAPE';
  if (lower.includes('enoent') || lower.includes('no such file')) return 'NOT_FOUND';
  if (lower.includes('eisdir') || lower.includes('is a directory')) return 'IS_DIRECTORY';
  return 'READ_ERROR';
}

/**
 * Resolve @file[:line[-end]] references and build a synthetic user message block.
 * Returns `message: null` when no references were found.
 */
export async function buildFileReferenceContextMessage(
  text: string,
  workspaceRoot: string,
): Promise<FileReferenceContextResult> {
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

  const resolved: ResolvedEntry[] = [];
  const errors: ReferenceError[] = [];
  const root: string = path.resolve(workspaceRoot);

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
      const filePath: string = await ensureInsideWorkspace(root, ref.path);
      const raw: string = await fs.readFile(filePath, 'utf8');
      const rendered = renderAnchoredRange(raw, ref.startLine ?? 1, ref.endLine ?? null);
      const textOut: string = truncateText(rendered.text, MAX_FILE_REFERENCE_CHARS);
      resolved.push({
        token: ref.token,
        path: path.relative(root, filePath) || '.',
        startLine: rendered.startLine,
        endLine: rendered.endLine,
        totalLines: rendered.totalLines,
        text: textOut,
        truncated: textOut.length < rendered.text.length,
      });
    } catch (err: unknown) {
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
export async function appendUserMessageWithFileReferences(
  state: ChatState,
  messageText: string,
  workspaceRoot: string,
  options: AppendOptions = {},
): Promise<FileReferenceContextResult> {
  state.messages.push({ role: 'user', content: messageText });

  const referenceSourceText: string =
    typeof options.referenceSourceText === 'string' ? options.referenceSourceText : messageText;

  const refs: FileReferenceContextResult = await buildFileReferenceContextMessage(
    referenceSourceText,
    workspaceRoot,
  );
  if (refs.message) {
    state.messages.push({ role: 'user', content: refs.message });
  }
  return refs;
}
