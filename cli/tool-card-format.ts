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

/**
 * Timing/bookkeeping keys that are never content in the generic fallback. A
 * card that genuinely wants to surface one of these should declare a formatter;
 * in the semantics-free dump they are noise (`Duration Ms: 57`, and the header
 * row already carries duration).
 */
const TELEMETRY_KEYS: ReadonlySet<string> = new Set(['durationMs', 'elapsedMs', 'startedAt']);

/**
 * Whether a generic-fallback field should be dropped rather than rendered as a
 * row. This is the LAST-RESORT dumper (a card type with no formatter), so the
 * rule is deliberately narrow:
 *
 *   - `undefined` / `''` — nothing to show.
 *   - a telemetry key — internal timing, never content.
 *   - `truncated: false` — a confirmation that nothing happened; the `true`
 *     case is kept, because a cut payload IS a fact a reader must see.
 *
 * Note what is NOT dropped: an arbitrary `false`. Blanket-hiding false would
 * silence a meaningful `passed: false` / `mergeable: false` in some future
 * card, and a dropped negative reads exactly like a clean pass — the silent-cap
 * failure this codebase treats as a bug, not a tidy-up. A false worth hiding
 * gets hidden by its own formatter, not here.
 */
function isEmptyCardValue(key: string, value: unknown): boolean {
  if (value === undefined || value === '') return true;
  if (TELEMETRY_KEYS.has(key)) return true;
  if (key === 'truncated' && value === false) return true;
  return false;
}

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

/**
 * A field the generic fallback should render as text rather than squeeze into a
 * row. `formatValue` truncates every string to VALUE_LIMIT, which is right for a
 * branch name and destroys a log: `get_job_logs` and `get_issue` (whose `body` is
 * prose) would each render as a 180-char stump.
 *
 * "Has a newline in its trimmed content" is the test. That is structure, not
 * meaning — the same class of judgment as "this array holds objects" — so it
 * stays inside the declared-not-sniffed line. A trailing newline alone does not
 * count: `"main\n"` is a branch name, not a document.
 */
function isTextBody(value: unknown): value is string {
  return typeof value === 'string' && value.trimEnd().includes('\n');
}

/**
 * Bound one body line WITHOUT normalizing whitespace.
 *
 * `truncate` collapses `\s+` to a single space, which is correct for a one-line
 * label and wrong for a document: it would strip the leading indent off every
 * line of a log or stack trace, which is most of what makes it readable.
 */
function clipLine(text: string): string {
  if (text.length <= VALUE_LIMIT) return text;
  return `${text.slice(0, VALUE_LIMIT - 1)}…`;
}

/**
 * Render a multi-line string field as a headed section.
 *
 * Deliberately tones every line `context`, unlike `boundedBodyLines`, which
 * colors `+`/`-` prefixes as diff add/delete. `diff-preview` has *declared*
 * itself a diff, so tinting its lines is reading the contract. An arbitrary log
 * has declared nothing — a stack trace line starting with `-` is not a deletion,
 * and coloring it red would be exactly the text-sniffing this track deleted.
 */
function textSectionLines(label: string, value: string): NonNullable<ToolCardDisplay['bodyLines']> {
  const prefix = value.slice(0, BODY_CHAR_LIMIT);
  const sourceTruncated = value.length > prefix.length;
  const all = prefix.trimEnd().split('\n');
  const shown = all.slice(0, BODY_LINE_LIMIT);
  const hidden = all.length - shown.length;

  // Two independent caps, and they can BOTH bite. `all` is derived from the
  // char-truncated prefix, so `all.length` and `hidden` only ever describe the
  // first BODY_CHAR_LIMIT chars — never the whole value. Reporting either as if
  // it were the total is a lie a reader cannot detect: a 50k-line CI log would
  // render as `Logs (2511 lines)` / `… +2271 more` and someone diagnosing a
  // failure would believe they had seen all of it.
  //
  // So: mark the count `+` when the source was cut, and emit BOTH signals rather
  // than letting one shadow the other. (`CLAUDE.md`: no silent caps — a bounded
  // render must say what it dropped, or it reads as complete.)
  const lines: NonNullable<ToolCardDisplay['bodyLines']> = [
    { text: `${label} (${all.length}${sourceTruncated ? '+' : ''} lines)`, tone: 'context' },
    ...shown.map((text) => ({ text: `  ${clipLine(text)}`, tone: 'context' as const })),
  ];
  const dropped: string[] = [];
  if (hidden > 0) dropped.push(`+${hidden} more`);
  if (sourceTruncated) dropped.push('payload truncated');
  if (dropped.length > 0) {
    lines.push({ text: `  … ${dropped.join(', ')}`, tone: 'context' });
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
 * `exec` / `sandbox` command card.
 *
 * The `type: 'sandbox'` card (a plain command that isn't a test run or a
 * typecheck) had no formatter and fell through to the generic key-dumper, which
 * rendered a raw struct: a `Sandbox` title, a `Command:` row duplicating the
 * header ("Ran rm …") verbatim, empty `Stdout:` / `Stderr:` rows, and
 * `Exit Code: 0` / `Truncated: false` / `Duration Ms: 57` — telemetry and
 * confirmations of nothing. For a command that succeeded silently, the header
 * row already IS the whole story, so the honest card is empty.
 *
 * What survives is only what a reader came for:
 *   - a nonzero exit code (zero is the default nobody needs told);
 *   - stderr, then stdout, and only when non-empty — stderr first because the
 *     reason a command failed is the point.
 *
 * No title (the header names the command), no Command row (same), no duration
 * (telemetry; already available to the header row) and no `Truncated: false`.
 * Returns an all-empty display for a clean silent run; the renderer drops a card
 * with no title, no rows and no body, leaving the header alone.
 */
function formatCommandCard(card: ToolCardPayload): ToolCardDisplay | null {
  const { data } = card;
  if (card.type !== 'sandbox' || typeof data.command !== 'string') return null;
  const stdout = typeof data.stdout === 'string' ? data.stdout.trimEnd() : '';
  const stderr = typeof data.stderr === 'string' ? data.stderr.trimEnd() : '';
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : 0;

  const rows: ToolCardDisplay['rows'] = [];
  if (exitCode !== 0) rows.push({ label: 'Exit', value: String(exitCode) });

  const bodyLines: NonNullable<ToolCardDisplay['bodyLines']> = [];
  const streams: Array<[string, string]> = [];
  if (stderr) streams.push(['stderr', stderr]);
  if (stdout) streams.push(['stdout', stdout]);
  // Label a stream only when it needs disambiguating: both present, or stderr
  // on its own (so warn-on-success output doesn't read as the command's result).
  // A lone stdout renders bare, like a read's preview.
  const labelStreams = streams.length > 1;
  for (const [name, value] of streams) {
    const all = value.split('\n');
    const shown = all.slice(0, BODY_LINE_LIMIT);
    const labelled = labelStreams || name === 'stderr';
    if (labelled) bodyLines.push({ text: `${name}:`, tone: 'context' });
    const indent = labelled ? '  ' : '';
    for (const line of shown)
      bodyLines.push({ text: `${indent}${clipLine(line)}`, tone: 'context' });
    // No silent cap: say what was dropped (CLAUDE.md). The producer already
    // char-bounds the streams; this is the line bound on top of it.
    if (all.length > shown.length) {
      bodyLines.push({ text: `${indent}… +${all.length - shown.length} more`, tone: 'context' });
    }
  }

  return {
    title: '',
    known: true,
    rows,
    ...(bodyLines.length > 0 ? { bodyLines } : {}),
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

  const specialized =
    formatDiffPreviewCard(card) ?? formatSandboxStateCard(card) ?? formatCommandCard(card);
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
    if (isEmptyCardValue(key, value)) continue;
    const label = humanize(key, LABEL_LIMIT);
    // An object list becomes a section instead of a row: a row could only ever
    // say "N items", and the count is already in the section header.
    if (isObjectList(value)) {
      bodyLines.push(...listSectionLines(label, value));
      continue;
    }
    // Likewise a multi-line string: a row would truncate a log to a stump.
    if (isTextBody(value)) {
      bodyLines.push(...textSectionLines(label, value));
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
