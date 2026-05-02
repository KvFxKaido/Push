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

function buildOmissionMarker(
  hasDiffContent: boolean,
  hasCodeBlock: boolean,
  listMeta: ListResultMeta | null,
  visibleItemCount: number,
): string {
  if (listMeta) {
    // Tell the next model turn the right epistemic status: the visible
    // lines are a sample, not the complete tool result. Without this,
    // models can treat the compacted N-line excerpt as if it were the
    // full data and either fabricate counts or hallucinate a "policy"
    // explaining the gap between their prior reasoning and what they
    // see now.
    const reRun = listMeta.toolName ? ` — re-run ${listMeta.toolName} for full detail` : '';
    if (visibleItemCount > 0 && visibleItemCount < listMeta.totalCount) {
      const omitted = listMeta.totalCount - visibleItemCount;
      return `[${omitted} more ${listMeta.itemNoun} omitted from original ${listMeta.totalCount}-item list; visible items are a sample, not the complete result${reRun}]`;
    }
    // Visible count couldn't be determined precisely (no per-noun item
    // pattern, or item lines didn't survive compaction). Fall back to a
    // marker that still carries the critical "sample, not complete"
    // signal plus the original total.
    return `[Original list had ${listMeta.totalCount} ${listMeta.itemNoun}; visible items are a sample, not the complete result${reRun}]`;
  }
  if (hasDiffContent) return '[diff content summarized]';
  if (hasCodeBlock) return '[code/content summarized]';
  return '[additional content summarized]';
}

interface ListResultMeta {
  totalCount: number;
  itemNoun: string;
  toolName: string | null;
}

// Patterns for "this line starts a new list item" — used to count how
// many items survived compaction so the omission marker can name a
// precise number. Keyed by the lowercased noun extracted from the
// count line (`commits`, `branches`, etc.). Any noun without an entry
// falls back to the conservative "Original list had N …" wording.
const LIST_ITEM_START_PATTERNS: Record<string, RegExp> = {
  commit: /^[a-f0-9]{7,40}[\s:]/i,
  commits: /^[a-f0-9]{7,40}[\s:]/i,
};

// Match the count line that every list-style tool result writes right
// under the `[Tool Result — …]` header. Captures the count plus the
// noun phrase ("recent commits", "branches", "files") up to the
// preposition or punctuation that terminates the count clause.
const LIST_COUNT_HEADER_RE =
  /^(?:Found\s+)?(\d+)\s+([A-Za-z][A-Za-z\s-]*?)(?=\s+(?:on|in|for|matching|changed|across|from|within)\b|[:,]|$)/;
const TRAILING_NOUN_RE = /([A-Za-z][A-Za-z-]+)\s*$/;

function detectListResultMeta(lines: string[]): ListResultMeta | null {
  if (lines.length === 0) return null;
  // Tool name is most reliably read from the `[Tool Result — toolName]`
  // header, which is always the first non-empty line of a tool reply.
  const toolMatch = lines[0].match(TOOL_RESULT_NAME_RE);
  const toolName = toolMatch?.[1]?.trim() || null;

  // The count line lives right under the tool-result header in every
  // list-style executor today (`N recent commits on …`, `N branches on
  // …`, `Found N files matching …`). Bound the scan so a stray match
  // deeper in the body can't masquerade as the header count.
  for (const line of lines.slice(0, 4)) {
    const match = line.match(LIST_COUNT_HEADER_RE);
    if (!match) continue;
    const count = Number.parseInt(match[1], 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    // The captured phrase may include modifiers ("recent commits",
    // "open PRs"). The trailing word is the actual noun we want.
    const phrase = match[2].trim();
    const nounMatch = phrase.match(TRAILING_NOUN_RE);
    if (!nounMatch) continue;
    // Preserve the original casing for display ("PRs", "Files") and
    // let the per-noun pattern lookup do its own lowercasing.
    return { totalCount: count, itemNoun: nounMatch[1], toolName };
  }

  return null;
}

function countVisibleListItems(summary: string[], itemNoun: string): number {
  const pattern = LIST_ITEM_START_PATTERNS[itemNoun.toLowerCase()];
  if (!pattern) return 0;
  return summary.filter((line) => pattern.test(line)).length;
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
  const hasToolResultHeader = TOOL_RESULT_HEADER_RE.test(headerLine);
  const headerIncluded = includeHeader && (hasToolResultHeader || headerLine.startsWith('['));
  // Gate list-meta detection on a real tool-result envelope. Otherwise
  // prose that happens to start with "3 options:" or "5 reasons …"
  // would trip the list-aware marker and mislabel ordinary text as a
  // truncated tool output.
  const listMeta = hasToolResultHeader ? detectListResultMeta(lines) : null;
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
    const visibleItemCount = listMeta ? countVisibleListItems(summary, listMeta.itemNoun) : 0;
    const marker = buildOmissionMarker(hasDiffContent, hasCodeBlock, listMeta, visibleItemCount);
    if (summary.length >= maxLines) {
      summary[maxLines - 1] = marker;
    } else {
      summary.push(marker);
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
