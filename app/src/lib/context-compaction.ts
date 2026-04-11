import type { ChatMessage } from '@/types';

const TOOL_RESULT_HEADER_RE = /^\[Tool Result\b/i;
const TOOL_RESULT_NAME_RE = /\[Tool Result(?:\s*[—-]\s*|\s+)([^\]\n]+)\]/i;
const TOOL_CALL_NAME_RE = /"tool"\s*:\s*"([^"]+)"/i;
const CODE_FENCE_RE = /^```/;
const META_LINE_RE = /^\[meta\]/i;
const BULLET_RE = /^(?:[-*]|\d+\.)\s+/;
const IMPORTANT_PREFIX_RE =
  /^(?:Status|Exit code|Command|Path|Paths|File|Files|Branch|Branches|Commit|Commits|Diff|Changed|Created|Deleted|Updated|Renamed|Review|PR|Repo|Runtime|Workspace|Sandbox|Error|Warning|Reason|Result|Stdout|Stderr|Summary|Next|Current round|Plan|Open tasks|Phase|Completed|Assumptions|Errors)\s*:/i;

interface SemanticSummaryOptions {
  includeHeader?: boolean;
  includeOmissionMarker?: boolean;
  maxLines?: number;
  maxCharsPerLine?: number;
}

interface CompactMessageOptions extends SemanticSummaryOptions {
  threshold?: number;
}

interface ContextSummaryBlockOptions {
  header: string;
  intro?: string;
  footerLines?: string[];
  fallbackPoint?: string;
  maxPoints?: number;
}

function truncateLine(line: string, maxChars = 220): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars - 3)}...`;
}

function normalizeSummaryKey(line: string): string {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

function lineHasPath(line: string): boolean {
  return /\/workspace\/\S+|(?:^|\s)[A-Za-z0-9._/-]+\.(?:[A-Za-z0-9]{1,8})(?:$|\s)/.test(line);
}

function collectReferencedPaths(lines: string[], limit = 3): string[] {
  const matches = new Set<string>();
  const pathRe =
    /\/workspace\/[^\s`'"]+|(?:^|\s)([A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|py|md|json|yml|yaml|css|html|sh|rb|go|rs|java))(?:$|\s)/g;

  for (const line of lines) {
    let match: RegExpExecArray | null;
    while ((match = pathRe.exec(line)) !== null) {
      const raw = match[0].trim();
      const path = raw.startsWith('/') ? raw : match[1] || raw;
      if (!path) continue;
      matches.add(path);
      if (matches.size >= limit) return [...matches];
    }
  }

  return [...matches];
}

function extractFirstNonEmptyLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildOmissionMarker(hasDiffContent: boolean, hasCodeBlock: boolean): string {
  if (hasDiffContent) return '[diff content summarized]';
  if (hasCodeBlock) return '[code/content summarized]';
  return '[additional content summarized]';
}

export function extractToolName(msg: ChatMessage): string | null {
  if (msg.isToolResult) {
    const match = msg.content.match(TOOL_RESULT_NAME_RE);
    return match?.[1]?.trim() || null;
  }

  if (!msg.isToolCall) return null;
  const match = msg.content.match(TOOL_CALL_NAME_RE);
  return match?.[1]?.trim() || null;
}

export function extractSemanticSummaryLines(
  content: string,
  {
    includeHeader = false,
    includeOmissionMarker = false,
    maxLines = 4,
    maxCharsPerLine = 220,
  }: SemanticSummaryOptions = {},
): string[] {
  const lines = extractFirstNonEmptyLines(content);
  if (lines.length === 0) return [];

  const summary: string[] = [];
  const seen = new Set<string>();
  const headerLine = lines[0];
  const headerIncluded =
    includeHeader && (TOOL_RESULT_HEADER_RE.test(headerLine) || headerLine.startsWith('['));
  let hasCodeBlock = false;
  let hasDiffContent = false;

  const addLine = (line: string): boolean => {
    const trimmed = truncateLine(line.trim(), maxCharsPerLine);
    if (!trimmed) return false;
    const key = normalizeSummaryKey(trimmed);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    summary.push(trimmed);
    return summary.length >= maxLines;
  };

  const reserveSlotForOmission = includeOmissionMarker ? 1 : 0;
  const summaryCapacity = Math.max(1, maxLines - reserveSlotForOmission);

  if (headerIncluded) {
    addLine(headerLine);
  }

  for (const line of lines) {
    if (CODE_FENCE_RE.test(line)) {
      hasCodeBlock = true;
      continue;
    }
    if (META_LINE_RE.test(line)) continue;
    if (/^(?:@@|diff --git|\+\+\+ |--- |\+[^+]|-[^-])/.test(line)) {
      hasDiffContent = true;
      continue;
    }
    if (
      summary.length < summaryCapacity &&
      !(headerIncluded && line === headerLine) &&
      (IMPORTANT_PREFIX_RE.test(line) || BULLET_RE.test(line))
    ) {
      addLine(line);
    }
  }

  for (const line of lines) {
    if (CODE_FENCE_RE.test(line)) {
      hasCodeBlock = true;
      continue;
    }
    if (META_LINE_RE.test(line)) continue;
    if (/^(?:@@|diff --git|\+\+\+ |--- |\+[^+]|-[^-])/.test(line)) {
      hasDiffContent = true;
      continue;
    }
    if (IMPORTANT_PREFIX_RE.test(line) || BULLET_RE.test(line)) continue;
    if (summary.length < summaryCapacity && !(headerIncluded && line === headerLine)) {
      addLine(line);
    }
  }

  if (summary.length < summaryCapacity) {
    const paths = collectReferencedPaths(lines);
    if (paths.length > 0 && !summary.some((line) => lineHasPath(line))) {
      addLine(`Files referenced: ${paths.join(', ')}`);
    }
  }

  const omittedContent =
    hasCodeBlock || hasDiffContent || lines.length > summary.length + (includeHeader ? 1 : 0);
  if (includeOmissionMarker && omittedContent) {
    if (summary.length >= maxLines) {
      summary[maxLines - 1] = buildOmissionMarker(hasDiffContent, hasCodeBlock);
    } else {
      summary.push(buildOmissionMarker(hasDiffContent, hasCodeBlock));
    }
  }

  return summary.slice(0, maxLines);
}

export function compactChatMessage(
  msg: ChatMessage,
  {
    threshold = msg.isToolResult ? 240 : 800,
    includeHeader = Boolean(msg.isToolResult),
    includeOmissionMarker = true,
    maxLines = msg.isToolResult ? 5 : 4,
    maxCharsPerLine = 220,
  }: CompactMessageOptions = {},
): ChatMessage {
  if (msg.content.length < threshold) return msg;

  const compactedLines = extractSemanticSummaryLines(msg.content, {
    includeHeader,
    includeOmissionMarker,
    maxLines,
    maxCharsPerLine,
  });

  if (compactedLines.length === 0) return msg;
  const compacted = compactedLines.join('\n');
  if (compacted.length >= msg.content.length) return msg;
  return { ...msg, content: compacted };
}

function buildContextPoint(msg: ChatMessage): string | null {
  if (msg.isToolCall) {
    const toolName = extractToolName(msg);
    return toolName
      ? `- Assistant requested ${toolName}.`
      : '- Assistant executed an earlier tool call.';
  }

  const summaryLines = extractSemanticSummaryLines(msg.content, {
    includeHeader: Boolean(msg.isToolResult),
    includeOmissionMarker: false,
    maxLines: msg.isToolResult ? 2 : 1,
    maxCharsPerLine: 200,
  });
  if (summaryLines.length === 0) return null;

  const summary = truncateLine(summaryLines.join(' | '), 240);
  if (msg.isToolResult) return `- ${summary}`;
  return `- ${msg.role === 'user' ? 'User' : 'Assistant'}: ${summary}`;
}

export function buildContextSummaryPoints(messages: ChatMessage[], maxPoints = 18): string[] {
  const points: string[] = [];

  for (const msg of messages) {
    if (points.length >= maxPoints) break;
    const point = buildContextPoint(msg);
    if (point) points.push(point);
  }

  return points;
}

export function buildContextSummaryBlock(
  messages: ChatMessage[],
  {
    header,
    intro,
    footerLines = [],
    fallbackPoint = '- Earlier context trimmed for token budget.',
    maxPoints = 18,
  }: ContextSummaryBlockOptions,
): string {
  const points = buildContextSummaryPoints(messages, maxPoints);

  return [
    header,
    ...(intro ? [intro] : []),
    ...(points.length > 0 ? points : [fallbackPoint]),
    ...footerLines.filter(Boolean),
  ].join('\n');
}
