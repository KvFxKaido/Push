import type { LlmMessage } from './provider-contract.js';

export interface CoderContextMessage extends LlmMessage {
  isToolResult?: boolean;
  isToolCall?: boolean;
}

const TOOL_RESULT_HEADER_RE = /^\[Tool Result\b/i;
const TOOL_RESULT_NAME_RE = /\[Tool Result(?:\s*[—-]\s*|\s+)([^\]\n]+)\]/i;
const TOOL_CALL_NAME_RE = /"tool"\s*:\s*"([^"]+)"/i;
const CODE_FENCE_RE = /^```/;
const META_LINE_RE = /^\[meta\]/i;
const BULLET_RE = /^(?:[-*]|\d+\.)\s+/;
const IMPORTANT_PREFIX_RE =
  /^(?:Status|Exit code|Command|Path|Paths|File|Files|Branch|Branches|Commit|Commits|Diff|Changed|Created|Deleted|Updated|Renamed|Review|PR|Repo|Runtime|Workspace|Sandbox|Error|Warning|Reason|Result|Stdout|Stderr|Summary|Next|Current round|Plan|Open tasks|Phase|Completed|Assumptions|Errors)\s*:/i;

function truncateLine(line: string, maxChars = 220): string {
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 3)}...`;
}

function normalizeSummaryKey(line: string): string {
  return line.toLowerCase().replace(/\s+/g, ' ').trim();
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
    while ((match = pathRe.exec(line))) {
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

export function extractSemanticSummaryLines(
  content: string,
  {
    includeHeader = false,
    includeOmissionMarker = false,
    maxLines = 4,
    maxCharsPerLine = 220,
  }: {
    includeHeader?: boolean;
    includeOmissionMarker?: boolean;
    maxLines?: number;
    maxCharsPerLine?: number;
  } = {},
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
    const marker = hasDiffContent
      ? '[diff content summarized]'
      : hasCodeBlock
        ? '[code/content summarized]'
        : '[additional content summarized]';
    if (summary.length >= maxLines) {
      summary[maxLines - 1] = marker;
    } else {
      summary.push(marker);
    }
  }

  return summary.slice(0, maxLines);
}

function extractToolName(msg: CoderContextMessage): string | null {
  if (msg.isToolResult) {
    const match = msg.content.match(TOOL_RESULT_NAME_RE);
    return match?.[1]?.trim() || null;
  }

  if (!msg.isToolCall) return null;
  const match = msg.content.match(TOOL_CALL_NAME_RE);
  return match?.[1]?.trim() || null;
}

function buildContextPoint(msg: CoderContextMessage): string | null {
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

export function buildContextSummaryBlock(
  messages: CoderContextMessage[],
  opts: { header: string; intro?: string; footerLines?: string[]; maxPoints?: number },
): string {
  const { header, intro, footerLines = [], maxPoints = 18 } = opts;
  const points: string[] = [];
  for (const msg of messages) {
    if (points.length >= maxPoints) break;
    const point = buildContextPoint(msg);
    if (point) points.push(point);
  }
  const fallback = '- Earlier context trimmed for token budget.';
  return [
    header,
    ...(intro ? [intro] : []),
    ...(points.length > 0 ? points : [fallback]),
    ...footerLines.filter(Boolean),
  ].join('\n');
}

export function normalizeTrimmedRoleAlternation(
  messages: CoderContextMessage[],
  round: number,
  now: () => number = Date.now,
): void {
  let bridgeCount = 0;

  for (let i = 1; i < messages.length; ) {
    const prev = messages[i - 1];
    const curr = messages[i];

    if (prev.role !== 'user' || curr.role !== 'user') {
      i++;
      continue;
    }

    if (curr.isToolResult) {
      messages.splice(i, 1);
      continue;
    }

    if (i - 1 === 0) {
      messages.splice(i, 0, {
        id: `coder-context-bridge-${round}-${bridgeCount++}`,
        role: 'assistant',
        content: '[Context bridge]\nUse the next user message as the latest guidance.',
        timestamp: now(),
      });
      i += 2;
      continue;
    }

    messages[i - 1] = {
      ...prev,
      content: `${prev.content}\n\n${curr.content}`,
    };
    messages.splice(i, 1);
  }
}
