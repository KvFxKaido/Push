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
const LIST_ITEM_LIMIT = 12;
const LIST_FIELD_LIMIT = 6;

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

/**
 * Title-cased tokens that should render as acronyms. A map rather than a
 * `toUpperCase()` because the plurals keep a lowercase `s` — `prs` is "PRs",
 * not "PRS", and object-list section headers are named after their field.
 */
const ACRONYMS: Readonly<Record<string, string>> = {
  Api: 'API',
  Ci: 'CI',
  Cli: 'CLI',
  Id: 'ID',
  Ids: 'IDs',
  Pr: 'PR',
  Prs: 'PRs',
  Sha: 'SHA',
  Tui: 'TUI',
  Url: 'URL',
  Urls: 'URLs',
};

function humanize(value: string, limit: number): string {
  const bounded = truncate(value, limit);
  const label = bounded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return truncate(
    label.replace(/\b(?:Api|Ci|Cli|Ids|Id|Prs|Pr|Sha|Tui|Urls|Url)\b/g, (token) => {
      return ACRONYMS[token] ?? token;
    }),
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

/**
 * A field the generic fallback can render as a list rather than a count.
 *
 * `formatValue` collapses any array it cannot join to `"N items"`. For arrays of
 * *scalars* that is fine — the count is the only honest summary once you pass the
 * preview limit. For arrays of *objects* it is not: the high-traffic cards
 * (`pr-list`, `ci-status`, `commit-list`, `branch-list`, `file-list`, ...) carry
 * exactly one such field, and it holds the entire reason the tool was called.
 * "Checks: 3 items" does not tell you which check failed.
 *
 * Empty arrays stay on the row path so they read as `Checks: none`.
 */
function isObjectList(value: unknown): value is ReadonlyArray<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
  );
}

/**
 * Summarize one list item from its *declared* scalar fields, values only, in
 * declaration order — `1463 · delete render sniffing · ishaw`.
 *
 * Values-only rather than `key=value` because these lists are homogeneous: the
 * columns repeat down the section, so the keys are noise after the first row.
 * Nested objects and arrays inside an item are skipped rather than expanded —
 * this is a bounded fallback, and a card that needs more has earned a
 * specialized formatter (see `formatDiffPreviewCard`).
 */
function formatListItem(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key in item) {
    if (!Object.hasOwn(item, key)) continue;
    if (parts.length >= LIST_FIELD_LIMIT) break;
    const value = item[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const rendered = truncate(String(value), VALUE_LIMIT);
      if (rendered.length > 0) parts.push(rendered);
    }
  }
  if (parts.length === 0) return '[structured data]';
  return truncate(parts.join(' · '), VALUE_LIMIT);
}

/**
 * Render an object-array field as a headed section of body lines. Slices before
 * mapping so a pathological 100k-item payload never allocates 100k summaries.
 */
function listSectionLines(
  label: string,
  items: ReadonlyArray<Record<string, unknown>>,
): NonNullable<ToolCardDisplay['bodyLines']> {
  const shown = items.slice(0, LIST_ITEM_LIMIT);
  const lines: NonNullable<ToolCardDisplay['bodyLines']> = [
    { text: `${label} (${items.length})`, tone: 'context' },
    ...shown.map((item) => ({ text: `  ${formatListItem(item)}`, tone: 'context' as const })),
  ];
  const hidden = items.length - shown.length;
  if (hidden > 0) {
    lines.push({ text: `  … +${hidden} more`, tone: 'context' });
  }
  return lines;
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
  const bodyLines: NonNullable<ToolCardDisplay['bodyLines']> = [];
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
    const label = humanize(key, LABEL_LIMIT);
    // An object list becomes a section instead of a row: a row could only ever
    // say "N items", and the count is already in the section header.
    if (isObjectList(value)) {
      bodyLines.push(...listSectionLines(label, value));
      continue;
    }
    rows.push({ label, value: formatValue(value) });
  }
  return {
    title: humanize(card.type, TITLE_LIMIT),
    rows,
    known: true,
    ...(bodyLines.length > 0 ? { bodyLines } : {}),
  };
}
