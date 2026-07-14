import { isToolCard, type ToolCardPayload } from '../lib/tool-cards.js';

export interface ToolCardDisplay {
  title: string;
  rows: Array<{ label: string; value: string }>;
  bodyLines?: Array<{ text: string; tone: 'add' | 'delete' | 'context' }>;
  known: boolean;
}

const VALUE_LIMIT = 180;
const TITLE_LIMIT = 80;
const LABEL_LIMIT = 48;
const ROW_LIMIT = 8;
const ARRAY_PREVIEW_LIMIT = 6;
const BODY_CHAR_LIMIT = 24_000;
const BODY_LINE_LIMIT = 240;

function truncate(value: string, limit: number): string {
  // Inspect only a bounded prefix. Slicing before whitespace normalization
  // avoids allocating against an arbitrarily large future-card string merely
  // to produce a short terminal label.
  const scanLimit = limit * 4;
  const prefix = value.slice(0, scanLimit);
  const sourceTruncated = value.length > scanLimit;
  const singleLine = prefix.replace(/\s+/g, ' ').trim();
  if (singleLine.length > limit) return `${singleLine.slice(0, limit - 1)}…`;
  if (!sourceTruncated) return singleLine;
  return `${singleLine.slice(0, Math.max(0, limit - 1))}…`;
}

function humanize(value: string, limit: number): string {
  const bounded = truncate(value, limit);
  const label = bounded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return truncate(
    label.replace(/\b(?:Api|Ci|Cli|Id|Pr|Sha|Tui|Url)\b/g, (token) => token.toUpperCase()),
    limit,
  );
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value, VALUE_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (
      value.length <= ARRAY_PREVIEW_LIMIT &&
      value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
    ) {
      return truncate(
        value.map((item) => truncate(String(item), VALUE_LIMIT)).join(', '),
        VALUE_LIMIT,
      );
    }
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  if (typeof value === 'object') return '[structured data]';
  return `[${typeof value}]`;
}

function boundedBodyLines(value: string): ToolCardDisplay['bodyLines'] {
  const prefix = value.slice(0, BODY_CHAR_LIMIT);
  const sourceTruncated = value.length > prefix.length;
  const sourceLines = prefix.split('\n');
  const lines = sourceLines.slice(0, BODY_LINE_LIMIT);
  const lineTruncated = sourceLines.length > lines.length;
  const bodyLines = lines.map((text) => ({
    text,
    tone:
      text.startsWith('+') && !text.startsWith('+++')
        ? ('add' as const)
        : text.startsWith('-') && !text.startsWith('---')
          ? ('delete' as const)
          : ('context' as const),
  }));
  if (sourceTruncated || lineTruncated) {
    bodyLines.push({ text: '[render payload truncated]', tone: 'context' });
  }
  return bodyLines;
}

function formatDiffPreviewCard(card: ToolCardPayload): ToolCardDisplay | null {
  const { data } = card;
  if (
    card.type !== 'diff-preview' ||
    typeof data.diff !== 'string' ||
    typeof data.filesChanged !== 'number' ||
    typeof data.additions !== 'number' ||
    typeof data.deletions !== 'number'
  ) {
    return null;
  }
  return {
    title: 'Diff Preview',
    known: true,
    rows: [
      { label: 'Files Changed', value: String(data.filesChanged) },
      { label: 'Additions', value: String(data.additions) },
      { label: 'Deletions', value: String(data.deletions) },
      ...(data.truncated === true ? [{ label: 'Truncated', value: 'true' }] : []),
    ],
    bodyLines: boundedBodyLines(data.diff),
  };
}

function formatSandboxStateCard(card: ToolCardPayload): ToolCardDisplay | null {
  const { data } = card;
  if (
    card.type !== 'sandbox-state' ||
    typeof data.repoPath !== 'string' ||
    typeof data.branch !== 'string' ||
    typeof data.changedFiles !== 'number' ||
    typeof data.stagedFiles !== 'number' ||
    typeof data.unstagedFiles !== 'number' ||
    typeof data.untrackedFiles !== 'number' ||
    !Array.isArray(data.preview)
  ) {
    return null;
  }
  const preview = data.preview
    .filter((line): line is string => typeof line === 'string')
    .slice(0, BODY_LINE_LIMIT)
    .map((text) => ({ text: truncate(text, VALUE_LIMIT), tone: 'context' as const }));
  return {
    title: 'Workspace Status',
    known: true,
    rows: [
      { label: 'Repo Path', value: truncate(data.repoPath, VALUE_LIMIT) },
      { label: 'Branch', value: truncate(data.branch, VALUE_LIMIT) },
      ...(typeof data.statusLine === 'string'
        ? [{ label: 'Status', value: truncate(data.statusLine, VALUE_LIMIT) }]
        : []),
      { label: 'Changed', value: String(data.changedFiles) },
      { label: 'Staged', value: String(data.stagedFiles) },
      { label: 'Unstaged', value: String(data.unstagedFiles) },
      { label: 'Untracked', value: String(data.untrackedFiles) },
    ],
    ...(preview.length > 0 ? { bodyLines: preview } : {}),
  };
}

/**
 * Turn a declared card into the bounded generic fallback shared by CLI
 * renderers. Known cards get title + key/value rows; unknown future card types
 * become an inert tombstone so persisted chats remain renderable.
 */
export function formatToolCard(card: ToolCardPayload): ToolCardDisplay {
  if (!isToolCard(card)) {
    const prefix = 'Unsupported tool card · ';
    return {
      title: `${prefix}${truncate(card.type, TITLE_LIMIT - prefix.length)}`,
      rows: [],
      known: false,
    };
  }

  const specialized = formatDiffPreviewCard(card) ?? formatSandboxStateCard(card);
  if (specialized) return specialized;

  const rows: ToolCardDisplay['rows'] = [];
  let visited = 0;
  for (const key in card.data) {
    visited += 1;
    if (visited > ROW_LIMIT) {
      rows.push({ label: 'More', value: 'Additional fields' });
      break;
    }
    if (!Object.hasOwn(card.data, key)) continue;
    const value = card.data[key];
    if (value === undefined) continue;
    rows.push({
      label: humanize(key, LABEL_LIMIT),
      value: formatValue(value),
    });
  }
  return {
    title: humanize(card.type, TITLE_LIMIT),
    rows,
    known: true,
  };
}
